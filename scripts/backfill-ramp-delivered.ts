// One-shot: pull recent Ramp `Payment received` (AR delivered) emails, parse,
// and upsert into ramp_payments. Used to seed the post-ramp-payment smoke test
// before going live on cron. Idempotent — re-running skips IDs we already have.

import "jsr:@std/dotenv/load";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseRampEmail } from "../supabase/functions/_shared/ramp-parser.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function googleAccessToken(): Promise<string> {
  const tok = JSON.parse(await Deno.readTextFile("google_token.json"));
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: tok.client_id,
      client_secret: tok.client_secret,
      refresh_token: tok.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  return (await resp.json()).access_token;
}

async function gmailJson(token: string, path: string): Promise<any> {
  const r = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return await r.json();
}

function decodeBase64Url(b64: string): string {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "===".slice((normalized.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function extractBodyText(payload: any): string {
  const out: string[] = [];
  const walk = (p: any) => {
    if (p.mimeType === "text/plain" && p.body?.data) {
      out.push(decodeBase64Url(p.body.data));
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out.join("\n\n");
}

const sb = createClient(
  Deno.env.get("SUPABASE_PROJECT_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const token = await googleAccessToken();

const q = encodeURIComponent('from:communications@ramp.com subject:"Payment received" newer_than:60d');
const list = await gmailJson(token, `/messages?q=${q}&maxResults=100`);
const stubs = list.messages ?? [];
console.log(`Found ${stubs.length} "Payment received" message(s).`);

let inserted = 0;
let skipped = 0;
const seenInBatch = new Set<string>();

for (const stub of stubs) {
  const msg = await gmailJson(token, `/messages/${stub.id}?format=full`);
  const subject = msg.payload.headers.find((h: any) => h.name === "Subject")?.value ?? "";
  const body = extractBodyText(msg.payload);
  const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
  const parsed = parseRampEmail(subject, body);

  if (!parsed) {
    console.log(`SKIP unparseable: ${subject.slice(0, 80)}`);
    continue;
  }
  if (parsed.direction !== "ar" || parsed.eventType !== "delivered") {
    skipped++;
    continue;
  }
  if (!parsed.rampPaymentId) {
    console.log(`SKIP no Payment ID: ${subject.slice(0, 80)}`);
    continue;
  }
  if (seenInBatch.has(parsed.rampPaymentId)) {
    skipped++;
    continue;
  }
  seenInBatch.add(parsed.rampPaymentId);

  const existing = await sb
    .from("ramp_payments")
    .select("id, status")
    .eq("ramp_payment_id", parsed.rampPaymentId)
    .maybeSingle();
  if (existing.data) {
    skipped++;
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
    status: "pending",
    email_message_id: msg.id,
    email_subject: subject,
    email_received_at: receivedAt,
    raw_email_body: body,
    raw_parse: parsed,
  });
  if (ins.error) {
    console.log(`ERROR ${parsed.rampPaymentId}: ${ins.error.message}`);
    continue;
  }
  inserted++;
}

console.log(`\nBackfill: ${inserted} inserted, ${skipped} skipped`);
