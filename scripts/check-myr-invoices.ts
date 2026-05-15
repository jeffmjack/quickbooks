import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient } from "../supabase/functions/_shared/qbo-client.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const qbo = new QBOClient(sb);
await qbo.init();

const myrQboVendorId = await sb
  .from("vendors")
  .select("qbo_vendor_id, name")
  .eq("id", 178)
  .single();
console.log("MYR vendor:", myrQboVendorId.data);

const invoiceNumbers = ["106063246", "106063339", "106063379", "106063461", "106063509"];

for (const docNum of invoiceNumbers) {
  console.log(`\n=== DocNumber = ${docNum} ===`);
  const bills = await qbo.query(
    `SELECT Id, DocNumber, VendorRef, TotalAmt, TxnDate, Balance FROM Bill WHERE DocNumber = '${docNum}'`,
  );
  if (bills.length === 0) {
    console.log("  (no bills in QBO with this DocNumber)");
  } else {
    for (const b of bills) {
      console.log({
        Id: b.Id,
        DocNumber: b.DocNumber,
        Vendor: `${b.VendorRef?.value} — ${b.VendorRef?.name}`,
        TotalAmt: b.TotalAmt,
        TxnDate: b.TxnDate,
        Balance: b.Balance,
      });
    }
  }
}

console.log("\n=== Recent MYR bills in QBO (last 60 days) ===");
const recent = await qbo.query(
  `SELECT Id, DocNumber, TotalAmt, TxnDate, Balance FROM Bill WHERE VendorRef = '${myrQboVendorId.data?.qbo_vendor_id}' ORDERBY TxnDate DESC MAXRESULTS 25`,
);
for (const b of recent) {
  console.log(`  ${b.TxnDate} | DocNum=${b.DocNumber} | $${b.TotalAmt} | Balance=$${b.Balance} | QBO Id=${b.Id}`);
}
