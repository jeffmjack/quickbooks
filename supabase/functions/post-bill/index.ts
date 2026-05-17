import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient, QBOApiError } from "../_shared/qbo-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let billId: number | null = null;
  let sb: ReturnType<typeof createClient> | null = null;

  try {
    const body = await req.json();
    billId = body.billId;
    if (!billId) {
      return jsonResponse({ error: "billId is required" }, 400);
    }

    sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Initialize QBO client (loads token from DB, refreshes)
    const qbo = new QBOClient(sb);
    await qbo.init();

    // Load bill with vendor and line items
    const { data: bill, error: billError } = await sb
      .from("bills")
      .select(
        "*, vendors(qbo_vendor_id, name), bill_line_items(*, qbo_accounts(qbo_account_id, name))",
      )
      .eq("id", billId)
      .single();

    if (billError || !bill) {
      return jsonResponse({ error: `Bill ${billId} not found` }, 404);
    }

    // Validate status
    if (bill.status === "posted") {
      return jsonResponse({
        message: `Bill ${billId} is already posted`,
        qbo_bill_id: bill.qbo_bill_id,
      });
    }

    if (bill.status !== "pending" && bill.status !== "reviewed") {
      return jsonResponse(
        { error: `Bill ${billId} has status '${bill.status}', expected 'pending' or 'reviewed'` },
        400,
      );
    }

    // Block posting when extraction warnings haven't been resolved. Reviewers
    // clear `error_message` (or move status to 'reviewed') after confirming the
    // bill against the source document.
    if (
      bill.status === "pending" &&
      typeof bill.error_message === "string" &&
      bill.error_message.startsWith("Review needed:")
    ) {
      return jsonResponse(
        {
          error:
            `Bill ${billId} has unresolved extraction warnings — review before posting. ` +
            bill.error_message,
        },
        400,
      );
    }

    // Validate vendor has QBO ID
    const vendor = bill.vendors;
    const qboVendorId = vendor?.qbo_vendor_id;
    if (!qboVendorId) {
      return jsonResponse(
        { error: `Vendor '${vendor?.name || "unknown"}' has no QBO vendor ID. Map the vendor first.` },
        400,
      );
    }

    // Validate all line items have account mappings
    const lineItems = bill.bill_line_items || [];
    const unmapped = lineItems.filter(
      (li: any) => !li.qbo_accounts?.qbo_account_id,
    );
    if (unmapped.length > 0) {
      const descriptions = unmapped.map((li: any) => li.description || `line ${li.line_number}`);
      return jsonResponse(
        { error: `${unmapped.length} line item(s) missing account mapping: ${descriptions.join(", ")}` },
        400,
      );
    }

    // Dupe check: does this bill already exist in QBO?
    const existing = await qbo.findBill(
      qboVendorId,
      bill.invoice_number,
      bill.invoice_date,
      bill.total_amount,
    );

    if (existing) {
      // Bill already in QBO — move this Supabase row to 'ignored' so it falls
      // out of the active worklist, but keep qbo_bill_id pointing at the
      // existing QBO bill for audit. error_message carries the reason; the
      // detail UI surfaces it via the "Ignored reason" card.
      const reason = `Already in QBO as bill #${existing.Id}` +
        (existing.DocNumber ? ` (DocNumber ${existing.DocNumber})` : "") +
        ". Did not post.";

      await sb
        .from("bills")
        .update({
          status: "ignored",
          qbo_bill_id: existing.Id,
          error_message: reason,
        })
        .eq("id", billId);

      return jsonResponse({
        message: reason,
        qbo_bill_id: existing.Id,
        duplicate: true,
      });
    }

    // Build QBO bill payload
    const lines = lineItems.map((li: any) => ({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: parseFloat(li.extended_price) || 0,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: li.qbo_accounts.qbo_account_id },
      },
      Description: li.description || undefined,
    }));

    const payload: Record<string, unknown> = {
      VendorRef: { value: qboVendorId },
      TxnDate: bill.invoice_date,
      DocNumber: bill.invoice_number,
      Line: lines,
    };
    if (bill.due_date) {
      payload.DueDate = bill.due_date;
    }

    // Post to QBO
    const result = await qbo.post("bill", payload) as any;
    const qboBillId = result?.Bill?.Id;

    if (!qboBillId) {
      await sb
        .from("bills")
        .update({ status: "error", error_message: "QBO returned no Bill ID" })
        .eq("id", billId);
      return jsonResponse({ error: "QBO returned success but no Bill ID" }, 502);
    }

    // Update bill in Supabase
    await sb
      .from("bills")
      .update({ status: "posted", qbo_bill_id: qboBillId })
      .eq("id", billId);

    return jsonResponse({
      message: `Posted to QBO as bill #${qboBillId}`,
      qbo_bill_id: qboBillId,
    });
  } catch (e) {
    // Mark bill as error if we got far enough to know the billId
    if (billId && sb && e instanceof QBOApiError) {
      try {
        await sb
          .from("bills")
          .update({ status: "error", error_message: e.body?.slice(0, 500) })
          .eq("id", billId);
      } catch {
        // Best effort — don't mask the original error
      }
    }

    return jsonResponse({ error: `${e}` }, 500);
  }
});
