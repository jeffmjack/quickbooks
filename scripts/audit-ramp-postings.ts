// Did post-ramp-payment actually create any QBO Receive Payments?
//
// Two signatures distinguish my code from manual bank-feed matching:
//   - PaymentRefNum = a Ramp Payment ID (10-char alphanumeric like "WWM2ZMWMSL")
//   - DepositToAccountRef = 36 (Undeposited Funds), not 217 (Chase Checking)
//   - PrivateNote starts with "Ramp"
// Bank-feed-matched Payments have all three of those blank/different.

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient } from "../supabase/functions/_shared/qbo-client.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const qbo = new QBOClient(sb);
await qbo.init();

// Get all Ramp Payment IDs we've staged.
const { data: rampRows } = await sb
  .from("ramp_payments")
  .select("ramp_payment_id, status, qbo_receive_payment_id, payer_name, invoice_number, amount");
const rampIds = (rampRows ?? []).map((r: any) => r.ramp_payment_id);
console.log(`Have ${rampIds.length} ramp_payment_id values staged.`);
console.log("Rows already linked to a QBO Payment (qbo_receive_payment_id):", (rampRows ?? []).filter((r: any) => r.qbo_receive_payment_id).length);
console.log("Rows with status='posted':", (rampRows ?? []).filter((r: any) => r.status === "posted").length);

// QBO query: any Payment with PaymentRefNum matching any of our staged Ramp IDs?
console.log("\n=== Searching QBO for Payments with PaymentRefNum matching a staged Ramp ID ===");
const matches: any[] = [];
const BATCH = 10;
for (let i = 0; i < rampIds.length; i += BATCH) {
  const slice = rampIds.slice(i, i + BATCH).map((id: string) => `'${id}'`).join(",");
  const found = await qbo.query(
    `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, CustomerRef, DepositToAccountRef, PrivateNote, MetaData FROM Payment WHERE PaymentRefNum IN (${slice}) MAXRESULTS 100`,
  );
  matches.push(...found);
}
console.log(`Found ${matches.length} QBO Payment(s) with our Ramp ID as PaymentRefNum.`);
for (const p of matches.slice(0, 10)) {
  console.log(`  ${p.MetaData?.CreateTime} | Payment ${p.Id} | $${p.TotalAmt} | ref=${p.PaymentRefNum} | ${p.CustomerRef?.name} | deposit→${p.DepositToAccountRef?.value}`);
  if (p.PrivateNote) console.log(`    note: ${p.PrivateNote.slice(0, 100)}`);
}

// Look for any Payment deposited to Undeposited Funds (36) in the last 7 days.
// This catches my code even if PaymentRefNum somehow got dropped.
console.log("\n=== Recent Payments deposited to Undeposited Funds (acct 36) in last 7 days ===");
const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
// DepositToAccountRef isn't queryable; fetch recent Payments and filter client-side.
const recentAll = await qbo.query(
  `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, CustomerRef, DepositToAccountRef, PrivateNote, MetaData FROM Payment WHERE TxnDate >= '${cutoff}' ORDERBY TxnDate DESC MAXRESULTS 200`,
);
const ufPayments = recentAll.filter((p: any) => p.DepositToAccountRef?.value === "36");
console.log(`Found ${ufPayments.length} Payment(s) → Undeposited Funds (filtered from ${recentAll.length} recent) since ${cutoff}.`);
for (const p of ufPayments.slice(0, 15)) {
  console.log(`  ${p.MetaData?.CreateTime} | Payment ${p.Id} | $${p.TotalAmt} | ref=${p.PaymentRefNum ?? "—"} | ${p.CustomerRef?.name}`);
  if (p.PrivateNote) console.log(`    note: ${p.PrivateNote.slice(0, 100)}`);
}

// Cross-check: are the recently-closed Summer Moon/Fresh Plus invoices showing
// up because of recent Payment activity, regardless of who did it?
console.log("\n=== Recent Payments for Summer Moon / Fresh Plus / Wheatsville customers (last 7 days) ===");
const recentPayments = await qbo.query(
  `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, CustomerRef, DepositToAccountRef, MetaData FROM Payment WHERE TxnDate >= '${cutoff}' ORDERBY TxnDate DESC MAXRESULTS 100`,
);
const interesting = recentPayments.filter((p: any) => {
  const name = (p.CustomerRef?.name ?? "").toLowerCase();
  return name.includes("summer moon") || name.includes("summermoon") || name.includes("fresh plus") || name.includes("wheatsville");
});
console.log(`${interesting.length} interesting payments. By DepositToAccount:`);
const byAcct: Record<string, number> = {};
for (const p of interesting) {
  const k = p.DepositToAccountRef?.value ?? "(none)";
  byAcct[k] = (byAcct[k] ?? 0) + 1;
}
console.log(byAcct);
console.log("Sample (showing creation time + who modified):");
for (const p of interesting.slice(0, 10)) {
  console.log(`  ${p.MetaData?.CreateTime} | Payment ${p.Id} | $${p.TotalAmt} | ref=${p.PaymentRefNum ?? "—"} | ${p.CustomerRef?.name} | deposit→${p.DepositToAccountRef?.value} | modBy=${p.MetaData?.LastModifiedByRef?.value ?? "?"}`);
}
