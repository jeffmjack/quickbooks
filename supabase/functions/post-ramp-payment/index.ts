// post-ramp-payment — turn staged Ramp AR `delivered` events into QBO Receive
// Payments deposited to Undeposited Funds.
//
// Modes:
//   POST {}                          → batch: process every pending+delivered+ar row
//   POST { rampPaymentId: 123 }      → single: process the named row only
//   POST { ..., dryRun: true }       → simulate. Logs what would happen; no QBO writes,
//                                      no Supabase status changes. Use to vet new
//                                      vendor coverage before going live.
//
// Eligibility for auto-post (all must hold):
//   - direction='ar', event_type='delivered', status='pending'
//   - invoice_number resolves to exactly one open QBO Invoice
//   - Ramp amount equals Invoice.Balance within $0.01
//
// Anything else → status='review' with a specific reason in error_message.
// Reviewer can either resolve in QBO and mark posted manually, or fix the
// underlying issue and re-run.
//
// Idempotency: before posting, we look up QBO for an existing Payment with
// PaymentRefNum = ramp_payment_id. If found, we link our row to the existing
// QBO payment without creating a duplicate. This protects against retries
// where we posted but failed to update Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient, QBOApiError } from "../_shared/qbo-client.ts";
import { captureEdgeError, flushSentry } from "../_shared/sentry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// QBO refs (discovered via scripts/find-qbo-receive-payment-refs.ts on 2026-05-15).
const QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID = "36";        // "1610 Undeposited Funds"
const QBO_PAYMENT_METHOD_ACH = "11";                   // "ACH"
const QBO_PAYMENT_METHOD_CHECK = "2";                  // "Check"

const AMOUNT_TOLERANCE = 0.01;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

type RampPaymentRow = {
  id: number;
  ramp_payment_id: string;
  direction: string;
  event_type: string;
  status: string;
  payer_name: string | null;
  invoice_number: string | null;
  amount: number | null;
  payment_type: string | null;
  payment_date: string | null;
  estimated_arrival: string | null;
  trace_id: string | null;
  qbo_receive_payment_id: string | null;
};

type AttemptOutcome = {
  rampPaymentRowId: number;
  rampPaymentId: string;
  result: "posted" | "already_posted" | "review" | "error";
  message: string;
  qboReceivePaymentId?: string;
};

function paymentMethodFor(paymentType: string | null): string | undefined {
  if (!paymentType) return undefined;
  const t = paymentType.toLowerCase();
  if (t.includes("ach")) return QBO_PAYMENT_METHOD_ACH;
  if (t.includes("check")) return QBO_PAYMENT_METHOD_CHECK;
  return undefined;
}

async function markReview(
  sb: SupabaseClient,
  rowId: number,
  reason: string,
): Promise<AttemptOutcome["result"]> {
  await sb
    .from("ramp_payments")
    .update({ status: "review", error_message: reason, updated_at: new Date().toISOString() })
    .eq("id", rowId);
  return "review";
}

async function markError(
  sb: SupabaseClient,
  rowId: number,
  reason: string,
): Promise<AttemptOutcome["result"]> {
  await sb
    .from("ramp_payments")
    .update({ status: "error", error_message: reason, updated_at: new Date().toISOString() })
    .eq("id", rowId);
  return "error";
}

async function attemptPost(
  sb: SupabaseClient,
  qbo: QBOClient,
  row: RampPaymentRow,
  dryRun: boolean,
): Promise<AttemptOutcome> {
  const outcome: AttemptOutcome = {
    rampPaymentRowId: row.id,
    rampPaymentId: row.ramp_payment_id,
    result: "error",
    message: "",
  };

  // In dry-run mode we want to short-circuit the side-effecting markers but
  // still report the outcome correctly. Replace markReview/markError calls
  // with no-op shims for this row.
  const markReviewLocal = async (reason: string) => {
    outcome.message = dryRun ? `[dryRun] would mark review: ${reason}` : reason;
    if (dryRun) return "review" as const;
    return await markReview(sb, row.id, reason);
  };
  const markErrorLocal = async (reason: string) => {
    outcome.message = dryRun ? `[dryRun] would mark error: ${reason}` : reason;
    if (dryRun) return "error" as const;
    return await markError(sb, row.id, reason);
  };

  // Eligibility — these rows should be filtered out at the SQL level but
  // double-check here in case of single-id invocation.
  if (row.direction !== "ar") {
    outcome.result = await markReviewLocal( `direction=${row.direction}, not AR — out of scope.`);
    outcome.message = "Skipped: AP direction.";
    return outcome;
  }
  if (row.event_type !== "delivered") {
    outcome.result = await markReviewLocal(
      `event_type=${row.event_type}; we only post on 'delivered'.`,
    );
    outcome.message = "Skipped: not a delivered event.";
    return outcome;
  }
  if (!row.invoice_number) {
    outcome.result = await markReviewLocal( "No invoice_number on row — can't resolve in QBO.");
    return outcome;
  }
  if (row.amount == null || row.amount <= 0) {
    outcome.result = await markReviewLocal( `Invalid amount: ${row.amount}`);
    return outcome;
  }

  // Idempotency: did we (or a prior run) already create a QBO Receive Payment
  // for this Ramp Payment ID? Walk QBO first; if found, link without re-posting.
  try {
    const existing = await qbo.findReceivePaymentByRefNum(row.ramp_payment_id);
    if (existing) {
      if (!dryRun) {
        await sb
          .from("ramp_payments")
          .update({
            status: "posted",
            qbo_receive_payment_id: existing.Id,
            qbo_customer_id: existing.CustomerRef?.value ?? null,
            qbo_customer_name: existing.CustomerRef?.name ?? null,
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }
      outcome.result = "already_posted";
      outcome.qboReceivePaymentId = existing.Id;
      outcome.message = `${dryRun ? "[dryRun] " : ""}Already in QBO as Payment ${existing.Id} — linked without re-posting.`;
      return outcome;
    }
  } catch (e) {
    outcome.result = await markErrorLocal(
      `QBO lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return outcome;
  }

  // Resolve invoice. We use the same approach as scan-deposits: look up by
  // global DocNumber, then disambiguate. For Ramp payments we have one
  // invoice number per event — multiple matches mean two open invoices share
  // a DocNumber (rare) and we need human review.
  let invoices: any[];
  try {
    invoices = await qbo.findInvoicesByDocNumber(row.invoice_number);
  } catch (e) {
    outcome.result = await markErrorLocal(
      `QBO invoice lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return outcome;
  }

  if (invoices.length === 0) {
    outcome.result = await markReviewLocal(
      `No QBO invoice found for DocNumber #${row.invoice_number}.`,
    );
    return outcome;
  }

  const open = invoices.filter((i) => parseFloat(i.Balance ?? "0") > 0);

  if (open.length === 0) {
    // All matching invoices are closed. Likely the bookkeeper already entered
    // this payment in QBO, or QB Payments bank-feed matched it. Either way
    // posting now would create a customer credit — not what we want. Park.
    const closedSummary = invoices
      .slice(0, 3)
      .map(
        (i) =>
          `Invoice ${i.Id} ($${i.TotalAmt}, balance $${i.Balance}, ${i.CustomerRef?.name ?? "?"})`,
      )
      .join("; ");
    outcome.result = await markReviewLocal(
      `Invoice #${row.invoice_number} is already closed in QBO (${closedSummary}). ` +
        `Possible double-payment by bookkeeper or bank-feed match — review before posting.`,
    );
    return outcome;
  }

  if (open.length > 1) {
    // Ambiguous: multiple open invoices share a DocNumber. Could happen if a
    // customer with multiple sub-accounts has identical invoice numbers.
    const candidates = open
      .map((i) => `${i.Id}/${i.CustomerRef?.name ?? "?"}/bal $${i.Balance}`)
      .join("; ");
    outcome.result = await markReviewLocal(
      `Multiple open QBO invoices match DocNumber #${row.invoice_number}: ${candidates}. Disambiguate manually.`,
    );
    return outcome;
  }

  const invoice = open[0];
  const invoiceBalance = parseFloat(invoice.Balance ?? "0");

  // Strict amount check — we don't auto-handle partials or overpays in v1.
  if (Math.abs(invoiceBalance - row.amount) > AMOUNT_TOLERANCE) {
    outcome.result = await markReviewLocal(
      `Amount mismatch on #${row.invoice_number}: Ramp paid $${row.amount}, ` +
        `QBO invoice balance is $${invoiceBalance.toFixed(2)} ` +
        `(Invoice ${invoice.Id}, ${invoice.CustomerRef?.name ?? "?"}). ` +
        `Could be a partial payment or wrong invoice — review.`,
    );
    return outcome;
  }

  // All gates passed — post.
  const customerQboId = invoice.CustomerRef?.value;
  const customerName = invoice.CustomerRef?.name ?? null;
  if (!customerQboId) {
    outcome.result = await markErrorLocal(
      `QBO Invoice ${invoice.Id} has no CustomerRef.value — unexpected schema.`,
    );
    return outcome;
  }

  const txnDate = row.payment_date ?? new Date().toISOString().slice(0, 10);
  const privateNote =
    `Ramp ${row.payment_type ?? "payment"} — Payment ID ${row.ramp_payment_id}` +
    (row.trace_id ? ` (trace ${row.trace_id})` : "") +
    (row.payer_name ? ` — from ${row.payer_name}` : "");

  if (dryRun) {
    outcome.result = "posted";
    outcome.message =
      `[dryRun] would post Receive Payment for $${row.amount} to ` +
      `${customerName} (QBO Cust ${customerQboId}) against Invoice ${invoice.Id} ` +
      `(#${row.invoice_number}, balance $${invoiceBalance.toFixed(2)}). ` +
      `Method: ${row.payment_type ?? "?"}; ref: ${row.ramp_payment_id}.`;
    return outcome;
  }

  try {
    const result = await qbo.createReceivePayment({
      customerQboId,
      invoiceQboId: invoice.Id,
      amount: row.amount,
      txnDate,
      depositToAccountQboId: QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID,
      paymentMethodQboId: paymentMethodFor(row.payment_type),
      paymentRefNum: row.ramp_payment_id,
      privateNote,
    }) as any;

    const qboPaymentId = result?.Payment?.Id;
    if (!qboPaymentId) {
      outcome.result = await markErrorLocal(
        `QBO returned success but no Payment.Id: ${JSON.stringify(result).slice(0, 300)}`,
      );
      return outcome;
    }

    await sb
      .from("ramp_payments")
      .update({
        status: "posted",
        qbo_receive_payment_id: qboPaymentId,
        qbo_customer_id: customerQboId,
        qbo_customer_name: customerName,
        qbo_invoice_id: invoice.Id,
        qbo_invoice_balance: invoiceBalance,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    outcome.result = "posted";
    outcome.qboReceivePaymentId = qboPaymentId;
    outcome.message = `Posted to QBO as Payment ${qboPaymentId} (${customerName}, $${row.amount}).`;
    return outcome;
  } catch (e) {
    const errBody = e instanceof QBOApiError ? e.body.slice(0, 400) : String(e);
    outcome.result = await markErrorLocal(`QBO post failed: ${errBody}`);
    return outcome;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: { rampPaymentId?: number; dryRun?: boolean } = {};
  if (req.method === "POST") {
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch {
      // No body / non-JSON → batch mode.
    }
  }
  const dryRun = !!body.dryRun;

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const qbo = new QBOClient(sb);
    await qbo.init();

    let rows: RampPaymentRow[] = [];
    if (body.rampPaymentId) {
      const { data, error } = await sb
        .from("ramp_payments")
        .select(
          "id, ramp_payment_id, direction, event_type, status, payer_name, invoice_number, amount, payment_type, payment_date, estimated_arrival, trace_id, qbo_receive_payment_id",
        )
        .eq("id", body.rampPaymentId)
        .single();
      if (error || !data) {
        return jsonResponse({ error: `ramp_payments.id=${body.rampPaymentId} not found` }, 404);
      }
      rows = [data as RampPaymentRow];
    } else {
      const { data } = await sb
        .from("ramp_payments")
        .select(
          "id, ramp_payment_id, direction, event_type, status, payer_name, invoice_number, amount, payment_type, payment_date, estimated_arrival, trace_id, qbo_receive_payment_id",
        )
        .eq("status", "pending")
        .eq("direction", "ar")
        .eq("event_type", "delivered")
        .order("payment_date", { ascending: true })
        .limit(50);
      rows = (data ?? []) as RampPaymentRow[];
    }

    if (rows.length === 0) {
      return jsonResponse({ message: "No eligible Ramp payments to post.", processed: 0 });
    }

    const outcomes: AttemptOutcome[] = [];
    for (const row of rows) {
      const out = await attemptPost(sb, qbo, row, dryRun);
      outcomes.push(out);
    }

    const counts = outcomes.reduce(
      (acc, o) => {
        acc[o.result] = (acc[o.result] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return jsonResponse({
      message:
        `${dryRun ? "[dryRun] " : ""}Processed ${outcomes.length}: ` +
        Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", "),
      dryRun,
      processed: outcomes.length,
      counts,
      outcomes,
    });
  } catch (e) {
    console.error("[post-ramp-payment]", e);
    captureEdgeError("post-ramp-payment", e);
    await flushSentry();
    return jsonResponse({ error: `${e}` }, 500);
  }
});
