// Find QBO PaymentMethod and Account IDs needed for posting Receive Payments
// from the Ramp pipeline:
//   - Undeposited Funds (the DepositToAccountRef destination)
//   - PaymentMethod "ACH" and "Check"
//
// Run: deno run -A scripts/find-qbo-receive-payment-refs.ts

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QBOClient } from "../supabase/functions/_shared/qbo-client.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const qbo = new QBOClient(sb);
await qbo.init();

console.log("=== Undeposited Funds account ===");
const accounts = await qbo.query(
  `SELECT Id, Name, AccountType, AccountSubType, Active FROM Account WHERE AccountSubType = 'UndepositedFunds'`,
);
for (const a of accounts) {
  console.log({ Id: a.Id, Name: a.Name, Active: a.Active });
}

console.log("\n=== Payment methods ===");
const methods = await qbo.query(
  `SELECT Id, Name, Type, Active FROM PaymentMethod MAXRESULTS 50`,
);
for (const m of methods) {
  console.log({ Id: m.Id, Name: m.Name, Type: m.Type, Active: m.Active });
}
