// Trace Payment for Invoice 50764 ($381.40, Summer Moon Dripping Springs, closed
// 10:44 PM CDT = 8:44 PM PDT on 2026-05-15).
//
// Print every field that could tell us who/what created it.

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient } from "../supabase/functions/_shared/qbo-client.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const qbo = new QBOClient(sb);
await qbo.init();

console.log("=== Invoice 50764 ===");
const invoices = await qbo.query(
  `SELECT * FROM Invoice WHERE DocNumber = '50764' AND TxnDate >= '2026-05-01'`,
);
for (const inv of invoices) {
  console.log(JSON.stringify({
    Id: inv.Id,
    DocNumber: inv.DocNumber,
    Customer: inv.CustomerRef,
    TotalAmt: inv.TotalAmt,
    Balance: inv.Balance,
    LinkedTxn: inv.LinkedTxn,
    MetaData: inv.MetaData,
  }, null, 2));
}

const invoiceIds = invoices.map((i: any) => i.Id);
const paymentIds = new Set<string>();
for (const inv of invoices) {
  for (const lt of inv.LinkedTxn ?? []) {
    if (lt.TxnType === "Payment") paymentIds.add(lt.TxnId);
  }
}

console.log(`\n=== Payments linked: ${[...paymentIds].join(", ")} ===`);
for (const pid of paymentIds) {
  const res = await qbo.get(`payment/${pid}`) as any;
  const p = res?.Payment;
  if (!p) {
    console.log(`(no payment ${pid})`);
    continue;
  }
  console.log(JSON.stringify({
    Id: p.Id,
    TxnDate: p.TxnDate,
    TotalAmt: p.TotalAmt,
    PaymentRefNum: p.PaymentRefNum,
    PaymentMethodRef: p.PaymentMethodRef,
    DepositToAccountRef: p.DepositToAccountRef,
    CustomerRef: p.CustomerRef,
    PrivateNote: p.PrivateNote,
    CustomField: p.CustomField,
    TxnSource: p.TxnSource,
    PaymentType: p.PaymentType,
    MetaData: p.MetaData,
    LinkedInvoices: (p.Line ?? []).map((l: any) => ({
      Amount: l.Amount,
      LinkedTxn: l.LinkedTxn,
    })),
  }, null, 2));
}

console.log("\n=== Who is user 9130348665306916? ===");
// QBO user lookup — not all account types support this, but try.
try {
  const users = await qbo.query(`SELECT * FROM CompanyInfo`);
  console.log("CompanyInfo:", users[0]?.CompanyName, users[0]?.Country, users[0]?.LegalName);
} catch (e) {
  console.log("CompanyInfo lookup failed:", e);
}

// Recent Payments to see if same user is creating all of these
console.log("\n=== Last 50 Payments — who's creating them? ===");
const recent = await qbo.query(
  `SELECT Id, TxnDate, TotalAmt, PaymentRefNum, CustomerRef, DepositToAccountRef, MetaData FROM Payment WHERE TxnDate >= '2026-05-10' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 50`,
);
let withUser = 0;
let noUser = 0;
const userIds = new Map<string, number>();
for (const p of recent) {
  const modBy = p.MetaData?.LastModifiedByRef?.value;
  if (modBy) {
    withUser++;
    userIds.set(modBy, (userIds.get(modBy) ?? 0) + 1);
  } else {
    noUser++;
  }
}
console.log(`Total: ${recent.length} | with LastModifiedByRef: ${withUser} | without: ${noUser}`);
console.log("Users seen:", Object.fromEntries(userIds));
console.log("\nDetail (newest first):");
for (const p of recent.slice(0, 30)) {
  const modBy = p.MetaData?.LastModifiedByRef?.value ?? "—NONE—";
  console.log(
    `${p.MetaData?.CreateTime} | P${p.Id} | $${String(p.TotalAmt).padStart(7)} | ` +
      `${(p.CustomerRef?.name ?? "?").slice(0, 32).padEnd(32)} | ` +
      `dep→${p.DepositToAccountRef?.value ?? "?"} | ref=${(p.PaymentRefNum ?? "—").padEnd(10)} | ` +
      `modBy=${modBy}`,
  );
}
