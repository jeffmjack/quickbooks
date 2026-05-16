// Mark the 50 backfilled historical Ramp `delivered` rows that are in
// status='review' as 'ignored' — they were handled manually by the bookkeeper
// before scan-ramp existed, so the "Invoice already closed in QBO" review
// reason is informational not actionable. Without this they'd clutter any
// Ramp Payments UI we add later.
//
// Scope: only rows where status='review' AND the error_message starts with
// the closed-invoice phrase. Hand-edits or future review states are untouched.

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const { data: rows, error } = await sb
  .from("ramp_payments")
  .select("id, ramp_payment_id, invoice_number, error_message")
  .eq("status", "review")
  .like("error_message", "Invoice%already closed in QBO%");

if (error) {
  console.error("Query failed:", error);
  Deno.exit(1);
}

console.log(`Found ${rows?.length ?? 0} historical review rows to mark ignored.`);
if (!rows?.length) Deno.exit(0);

for (const r of rows) {
  const newMsg = `Pre-deployment historical event — handled manually by bookkeeper before scan-ramp existed. Original review reason: ${r.error_message}`;
  await sb
    .from("ramp_payments")
    .update({
      status: "ignored",
      error_message: newMsg,
      updated_at: new Date().toISOString(),
    })
    .eq("id", r.id);
}

console.log(`Updated ${rows.length} row(s) → status='ignored'.`);
