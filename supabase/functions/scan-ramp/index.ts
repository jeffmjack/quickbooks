// scan-ramp — stage Ramp AR payment notifications from billing@thegreencart.com.
//
// Why a separate function (not part of scan-email):
//   - Gmail filter on billing@ strips UNREAD from communications@ramp.com
//     before scan-email's `is:unread` query sees them, so we'd never pick them
//     up there.
//   - Ramp events have their own idempotency key (`Payment ID`), independent
//     of email message id.
//
// What this does:
//   1. Query Gmail for recent Ramp emails by sender (label-agnostic).
//   2. For each, classify by subject — AR initiated, AR delivered, AP, or skip.
//   3. Parse the body for amount/dates/Payment ID.
//   4. Upsert into ramp_payments keyed by ramp_payment_id (idempotent — Ramp
//      sometimes re-sends the same event with a different Gmail message id).
//   5. Leave `status='pending'`. QBO posting is a separate function (next PR).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseRampEmail } from "../_shared/ramp-parser.ts";
import { captureEdgeError, flushSentry } from "../_shared/sentry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function getGoogleAccessToken(): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

type GmailMessageStub = { id: string };

type GmailPart = {
  mimeType: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

type GmailMessage = {
  id: string;
  internalDate?: string;
  payload: {
    headers: { name: string; value: string }[];
    mimeType: string;
    parts?: GmailPart[];
    body?: { data?: string };
  };
};

async function searchRampMessages(token: string): Promise<GmailMessageStub[]> {
  // No `is:unread` — Gmail filter already stripped UNREAD on these. We rely
  // on DB-side idempotency (ramp_payment_id UNIQUE) to skip ones we've seen.
  // 30 days back is plenty for an every-hour cron; first run will catch up.
  const q = encodeURIComponent("from:communications@ramp.com newer_than:30d");
  const resp = await fetch(
    `${GMAIL_BASE}/messages?q=${q}&maxResults=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await resp.json();
  return (data.messages ?? []) as GmailMessageStub[];
}

async function getMessage(token: string, id: string): Promise<GmailMessage> {
  const resp = await fetch(
    `${GMAIL_BASE}/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return await resp.json();
}

function getHeader(msg: GmailMessage, name: string): string {
  for (const h of msg.payload.headers ?? []) {
    if (h.name.toLowerCase() === name.toLowerCase()) return h.value;
  }
  return "";
}

function decodeBase64Url(b64: string): string {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "===".slice((normalized.length + 3) % 4));
  // Bytes → UTF-8 string
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function extractBodyText(payload: GmailMessage["payload"]): string {
  const out: string[] = [];
  const visit = (part: GmailPart) => {
    if (part.mimeType === "text/plain" && part.body?.data) {
      out.push(decodeBase64Url(part.body.data));
    } else if (part.parts) {
      for (const p of part.parts) visit(p);
    }
  };
  if (payload.parts) {
    for (const p of payload.parts) visit(p);
  } else if (payload.mimeType === "text/plain" && payload.body?.data) {
    out.push(decodeBase64Url(payload.body.data));
  }
  return out.join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const googleToken = await getGoogleAccessToken();
    const stubs = await searchRampMessages(googleToken);

    const seenIds = new Set<string>();
    let staged = 0;
    let skippedDup = 0;
    let skippedUnrecognized = 0;
    let skippedAp = 0;
    const errors: string[] = [];

    for (const stub of stubs) {
      try {
        const msg = await getMessage(googleToken, stub.id);
        const subject = getHeader(msg, "Subject");
        const body = extractBodyText(msg.payload);
        const receivedAt = msg.internalDate
          ? new Date(Number(msg.internalDate)).toISOString()
          : null;

        const parsed = parseRampEmail(subject, body);
        if (!parsed) {
          skippedUnrecognized++;
          continue;
        }

        // Park AP events without acting on them — separate PR will handle
        // bill-payment matching/posting.
        if (parsed.direction === "ap") {
          skippedAp++;
          if (parsed.rampPaymentId && !seenIds.has(parsed.rampPaymentId)) {
            seenIds.add(parsed.rampPaymentId);
            await sb.from("ramp_payments").upsert(
              {
                ramp_payment_id: parsed.rampPaymentId,
                direction: "ap",
                event_type: parsed.eventType,
                payer_name: parsed.payerName,
                invoice_number: parsed.invoiceNumber,
                amount: parsed.amount,
                payment_type: parsed.paymentType,
                payment_date: parsed.paymentDate,
                estimated_arrival: parsed.estimatedArrival,
                trace_id: parsed.traceId,
                status: "ignored",
                error_message: "AP-direction event — not yet handled.",
                email_message_id: msg.id,
                email_subject: subject,
                email_received_at: receivedAt,
                raw_email_body: body,
                raw_parse: parsed,
              },
              { onConflict: "ramp_payment_id" },
            );
          }
          continue;
        }

        if (!parsed.rampPaymentId) {
          errors.push(`msg ${msg.id}: parsed but no Payment ID — subject=${subject}`);
          continue;
        }

        if (seenIds.has(parsed.rampPaymentId)) {
          skippedDup++;
          continue;
        }
        seenIds.add(parsed.rampPaymentId);

        // Idempotency: upsert keyed by ramp_payment_id. If the row already
        // exists we leave its status alone — initial intent was to stage,
        // not overwrite a posted/error row from a later re-send. Use
        // ignoreDuplicates so existing rows stay intact.
        const existing = await sb
          .from("ramp_payments")
          .select("id, status")
          .eq("ramp_payment_id", parsed.rampPaymentId)
          .maybeSingle();

        if (existing.data) {
          skippedDup++;
          continue;
        }

        const ins = await sb.from("ramp_payments").insert({
          ramp_payment_id: parsed.rampPaymentId,
          direction: parsed.direction,
          event_type: parsed.eventType,
          payer_name: parsed.payerName,
          invoice_number: parsed.invoiceNumber,
          amount: parsed.amount,
          payment_type: parsed.paymentType,
          payment_date: parsed.paymentDate,
          estimated_arrival: parsed.estimatedArrival,
          trace_id: parsed.traceId,
          status: parsed.eventType === "delivered" ? "pending" : "ignored",
          error_message:
            parsed.eventType === "initiated"
              ? "`initiated` event — waiting for `delivered` before posting."
              : null,
          email_message_id: msg.id,
          email_subject: subject,
          email_received_at: receivedAt,
          raw_email_body: body,
          raw_parse: parsed,
        });

        if (ins.error) {
          errors.push(`msg ${msg.id}: insert failed — ${ins.error.message}`);
          continue;
        }
        staged++;
      } catch (e) {
        errors.push(`msg ${stub.id}: ${e}`);
      }
    }

    return new Response(
      JSON.stringify({
        message: `Scanned ${stubs.length} Ramp email(s): ${staged} staged, ${skippedDup} duplicates, ${skippedUnrecognized} unrecognized, ${skippedAp} AP-side (parked), ${errors.length} error(s)`,
        scanned: stubs.length,
        staged,
        skipped_duplicate: skippedDup,
        skipped_unrecognized: skippedUnrecognized,
        skipped_ap: skippedAp,
        errors,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[scan-ramp]", e);
    captureEdgeError("scan-ramp", e);
    await flushSentry();
    return new Response(
      JSON.stringify({ error: `${e}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
