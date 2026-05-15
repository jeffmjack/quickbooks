// One-off cleanup for the MYR situation found 2026-05-15:
//   1. Vendor #178 (MYR Wholesale, Inc.) was never linked to QBO (qbo_vendor_id was null).
//      The QBO record is "MYR Wholesale (tortillas)" at QBO Id 375.
//   2. Several pending bills already exist in QBO (Amerykah keys MYR manually).
//      For each pending MYR bill where a matching QBO bill exists (DocNumber+VendorRef),
//      mark the Supabase bill as `ignored` and stamp qbo_bill_id with the QBO match.
//
// Re-runnable: linking is idempotent (UPDATE WHERE qbo_vendor_id IS NULL); QBO match-and-mark
// only touches bills still in `pending` status, so re-running won't double-process.

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient } from "../../supabase/functions/_shared/qbo-client.ts";

const MYR_SUPABASE_VENDOR_ID = 111;
const MYR_QBO_VENDOR_ID = "375";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const qbo = new QBOClient(sb);
await qbo.init();

// 1. Link the vendor (idempotent).
const vendorBefore = await sb
  .from("vendors")
  .select("id, name, qbo_vendor_id")
  .eq("id", MYR_SUPABASE_VENDOR_ID)
  .single();
console.log("Vendor before:", vendorBefore.data);

if (!vendorBefore.data?.qbo_vendor_id) {
  const upd = await sb
    .from("vendors")
    .update({ qbo_vendor_id: MYR_QBO_VENDOR_ID })
    .eq("id", MYR_SUPABASE_VENDOR_ID)
    .select()
    .single();
  if (upd.error) {
    console.error("Vendor link failed:", upd.error);
    Deno.exit(1);
  }
  console.log("Vendor linked:", upd.data);
} else {
  console.log(`Vendor already linked to QBO ${vendorBefore.data.qbo_vendor_id} — skipping.`);
}

// 2. For each pending MYR bill, check QBO for an existing match by DocNumber+VendorRef.
const pending = await sb
  .from("bills")
  .select("id, invoice_number, total_amount, invoice_date, source, status, qbo_bill_id")
  .eq("vendor_id", MYR_SUPABASE_VENDOR_ID)
  .eq("status", "pending");

if (pending.error) {
  console.error("Failed to load pending bills:", pending.error);
  Deno.exit(1);
}

console.log(`\nChecking ${pending.data!.length} pending MYR bill(s) against QBO...\n`);

const escapeSql = (s: string) => s.replace(/'/g, "\\'");

for (const bill of pending.data!) {
  if (!bill.invoice_number) {
    console.log(`  #${bill.id}: no invoice_number, skipping`);
    continue;
  }
  const docNum = escapeSql(bill.invoice_number);
  const matches = await qbo.query(
    `SELECT Id, DocNumber, TotalAmt, TxnDate, Balance FROM Bill ` +
      `WHERE DocNumber = '${docNum}' AND VendorRef = '${MYR_QBO_VENDOR_ID}'`,
  );
  if (matches.length === 0) {
    console.log(`  #${bill.id} inv=${bill.invoice_number} $${bill.total_amount} — NOT in QBO, leaving pending`);
    continue;
  }
  const match = matches[0];
  const note =
    `Already posted to QBO as Bill ${match.Id} ` +
    `(DocNum=${match.DocNumber}, $${match.TotalAmt}, ${match.TxnDate}, balance $${match.Balance}). ` +
    `Auto-ignored by myr-cleanup-2026-05-15.`;
  const upd = await sb
    .from("bills")
    .update({
      status: "ignored",
      qbo_bill_id: match.Id,
      error_message: note,
    })
    .eq("id", bill.id)
    .select()
    .single();
  if (upd.error) {
    console.error(`  #${bill.id} update failed:`, upd.error);
    continue;
  }
  console.log(
    `  #${bill.id} inv=${bill.invoice_number} $${bill.total_amount} → ignored (matches QBO Bill ${match.Id})`,
  );
}

console.log("\nDone.");
