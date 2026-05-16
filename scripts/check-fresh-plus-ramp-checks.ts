// Test: does Ramp's QBO integration auto-post for check-rail too, or only ACH?
//
// We have 9 Fresh Plus `is on the way` (initiated) check-rail events from
// 2026-05-14 with estimated arrival 2026-05-22. If Ramp's integration posts
// only when funds actually clear (10+ days for mailed check), these invoices
// should all still be open *today* (2026-05-15) with balance > 0. If Ramp
// posts on initiated, they'll already be closed.

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient } from "../supabase/functions/_shared/qbo-client.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const qbo = new QBOClient(sb);
await qbo.init();

// Pull our staged Fresh Plus check-rail events
const { data: rows } = await sb
  .from("ramp_payments")
  .select("invoice_number, amount, payment_type, payment_date, estimated_arrival, payer_name")
  .eq("direction", "ar")
  .ilike("payer_name", "%fresh plus%");

console.log(`Have ${rows?.length ?? 0} Fresh Plus Ramp event(s) staged.\n`);
if (!rows?.length) Deno.exit(0);

for (const r of rows) {
  if (!r.invoice_number) continue;
  const invs = await qbo.findInvoicesByDocNumber(r.invoice_number);
  if (invs.length === 0) {
    console.log(`#${r.invoice_number} $${r.amount} ${r.payment_type} arr=${r.estimated_arrival} → no QBO match`);
    continue;
  }
  const inv = invs[0];
  const balance = parseFloat(inv.Balance ?? "0");
  const status = balance > 0 ? "OPEN" : "CLOSED";
  console.log(
    `#${r.invoice_number} $${r.amount} ${r.payment_type} arr=${r.estimated_arrival} ` +
      `→ QBO Invoice ${inv.Id} ${inv.CustomerRef?.name}, balance $${balance} [${status}]`,
  );
}
