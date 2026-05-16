// Smoke-test the Ramp parser against real samples pulled from billing@.
// Run: deno run -A scripts/test-ramp-parser.ts
//
// Pulls 20 most recent Ramp emails, runs the parser, prints a compact summary
// of (subject → parsed fields). Eyeball the output to spot misparses before
// deploying.

import "jsr:@std/dotenv/load";
import { parseRampEmail } from "../supabase/functions/_shared/ramp-parser.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function googleAccessToken(): Promise<string> {
  const tokFile = await Deno.readTextFile("google_token.json");
  const tok = JSON.parse(tokFile);
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
  const data = await resp.json();
  return data.access_token;
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
  const visit = (part: any) => {
    if (part.mimeType === "text/plain" && part.body?.data) {
      out.push(decodeBase64Url(part.body.data));
    } else if (part.parts) {
      for (const p of part.parts) visit(p);
    }
  };
  if (payload.parts) for (const p of payload.parts) visit(p);
  else if (payload.mimeType === "text/plain" && payload.body?.data) out.push(decodeBase64Url(payload.body.data));
  return out.join("\n\n");
}

function getHeader(msg: any, name: string): string {
  for (const h of msg.payload.headers ?? []) {
    if (h.name.toLowerCase() === name.toLowerCase()) return h.value;
  }
  return "";
}

const token = await googleAccessToken();
// Wide window so we capture each subject family at least once
const q = encodeURIComponent("from:communications@ramp.com newer_than:180d");
const list = await gmailJson(token, `/messages?q=${q}&maxResults=100`);
const stubs = list.messages ?? [];

console.log(`Found ${stubs.length} message(s).\n`);

let arCount = 0;
let apCount = 0;
let unrecognized = 0;
const seenIds = new Set<string>();

for (const stub of stubs) {
  const msg = await gmailJson(token, `/messages/${stub.id}?format=full`);
  const subject = getHeader(msg, "Subject");
  const body = extractBodyText(msg.payload);
  const parsed = parseRampEmail(subject, body);

  if (!parsed) {
    unrecognized++;
    console.log(`SKIP   subject=${subject!.slice(0, 90)}`);
    continue;
  }

  const dupTag = parsed.rampPaymentId && seenIds.has(parsed.rampPaymentId) ? "  [DUP]" : "";
  if (parsed.rampPaymentId) seenIds.add(parsed.rampPaymentId);

  if (parsed.direction === "ar") arCount++;
  else apCount++;

  console.log(
    `${parsed.direction.toUpperCase()} ${parsed.eventType.padEnd(10)} ` +
      `inv=${(parsed.invoiceNumber ?? "?").padEnd(12)} ` +
      `$${String(parsed.amount ?? "?").padStart(8)} ` +
      `${(parsed.paymentType ?? "?").padEnd(6)} ` +
      `paid=${parsed.paymentDate ?? "?"} arr=${parsed.estimatedArrival ?? "?"} ` +
      `id=${parsed.rampPaymentId ?? "?"}${dupTag}`,
  );
  console.log(`        payer=${parsed.payerName ?? "?"}  trace=${parsed.traceId ?? "—"}`);
}

console.log(`\n=== Summary ===`);
console.log(`AR events:      ${arCount}`);
console.log(`AP events:      ${apCount}`);
console.log(`Unrecognized:   ${unrecognized}`);
console.log(`Unique pay-ids: ${seenIds.size}`);
