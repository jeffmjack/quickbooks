// Investigate: between two dry-runs of post-ramp-payment, Invoice 92584
// (#50546, Summer Moon Buda, $117.80) went from open to closed.
// Show the current state in QBO and any recent payments/transactions.

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient } from "../supabase/functions/_shared/qbo-client.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const qbo = new QBOClient(sb);
await qbo.init();

console.log("=== Invoice 92584 (DocNumber 50546) ===");
const inv = await qbo.query(`SELECT * FROM Invoice WHERE Id = '92584'`);
const i = inv[0];
console.log({
  Id: i.Id,
  DocNumber: i.DocNumber,
  Customer: `${i.CustomerRef?.value} — ${i.CustomerRef?.name}`,
  TxnDate: i.TxnDate,
  TotalAmt: i.TotalAmt,
  Balance: i.Balance,
  MetaData: i.MetaData,
  LinkedTxn: i.LinkedTxn,
});

console.log("\n=== Payments linked to this invoice ===");
// QBO Payment table — find Payments where any LinkedTxn references this invoice
const payments = await qbo.query(
  `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, CustomerRef, PaymentMethodRef, DepositToAccountRef, PrivateNote, MetaData, Line FROM Payment WHERE CustomerRef = '390' AND TxnDate >= '2026-04-01' ORDERBY TxnDate DESC MAXRESULTS 20`,
);
for (const p of payments) {
  const linksThisInv = (p.Line ?? []).some((l: any) =>
    (l.LinkedTxn ?? []).some((lt: any) => lt.TxnId === "92584"),
  );
  if (!linksThisInv) continue;
  console.log({
    Id: p.Id,
    TxnDate: p.TxnDate,
    TotalAmt: p.TotalAmt,
    PaymentRefNum: p.PaymentRefNum ?? "(none)",
    PaymentMethod: p.PaymentMethodRef?.value,
    DepositToAccount: p.DepositToAccountRef?.value,
    PrivateNote: p.PrivateNote ?? "(none)",
    Created: p.MetaData?.CreateTime,
    LastUpdated: p.MetaData?.LastUpdatedTime,
  });
}
