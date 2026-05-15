import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractInvoice } from "../_shared/extraction.ts";
import { stageBill } from "../_shared/bill-staging.ts";
import { QBOClient } from "../_shared/qbo-client.ts";
import { getOrCreateSubfolder, uploadFile } from "../_shared/drive.ts";
import { captureEdgeError, flushSentry } from "../_shared/sentry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Google OAuth ────────────────────────────────────────────────────────────

async function getGoogleAccessToken(): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
    }),
  });
  const data = await resp.json();
  if (!data.access_token)
    throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Gmail helpers ───────────────────────────────────────────────────────────

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

type GmailMessage = {
  id: string;
  labelIds?: string[];
  payload: {
    headers: { name: string; value: string }[];
    parts?: GmailPart[];
    mimeType: string;
    body?: { attachmentId?: string; size: number; data?: string };
  };
};

type GmailPart = {
  mimeType: string;
  filename: string;
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailPart[];
};

async function listUnreadMessages(
  token: string,
): Promise<{ id: string }[]> {
  const q = encodeURIComponent("is:unread");
  const resp = await fetch(
    `${GMAIL_BASE}/messages?q=${q}&maxResults=20`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await resp.json();
  return data.messages || [];
}

async function getMessage(
  token: string,
  messageId: string,
): Promise<GmailMessage> {
  const resp = await fetch(
    `${GMAIL_BASE}/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return resp.json();
}

async function getAttachment(
  token: string,
  messageId: string,
  attachmentId: string,
): Promise<ArrayBuffer> {
  const resp = await fetch(
    `${GMAIL_BASE}/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await resp.json();
  const b64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function markAsRead(token: string, messageId: string): Promise<void> {
  await fetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
}

/**
 * After staging a bill from email: archive the message and ensure the `bill`
 * label is applied so it stays searchable from the Gmail label sidebar.
 * Inbox stays clean; nothing is lost.
 */
async function markBillEmailHandled(
  token: string,
  messageId: string,
  alreadyHasBillLabel: boolean,
): Promise<void> {
  await fetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      addLabelIds: alreadyHasBillLabel ? undefined : ["Label_5800834809592445520"],
      removeLabelIds: ["UNREAD", "INBOX"],
    }),
  });
}

async function archiveMessage(token: string, messageId: string): Promise<void> {
  await fetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD", "INBOX"] }),
  });
}

async function forwardToInfo(
  token: string,
  messageId: string,
  subject: string,
  from: string,
): Promise<void> {
  const raw = btoa(
    `From: billing@thegreencart.com\r\n` +
    `To: info@thegreencart.com\r\n` +
    `Subject: Fwd: ${subject}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    `Forwarded from billing@ — original sender: ${from}\r\n` +
    `Gmail message ID: ${messageId}`
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
}

function getHeader(msg: GmailMessage, name: string): string {
  const h = msg.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value || "";
}

function collectAttachments(
  parts: GmailPart[] | undefined,
): { mimeType: string; filename: string; attachmentId: string }[] {
  const results: {
    mimeType: string;
    filename: string;
    attachmentId: string;
  }[] = [];
  if (!parts) return results;

  for (const part of parts) {
    if (
      part.body?.attachmentId &&
      part.filename &&
      (part.mimeType === "application/pdf" ||
        part.mimeType.startsWith("image/"))
    ) {
      results.push({
        mimeType: part.mimeType,
        filename: part.filename,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      results.push(...collectAttachments(part.parts));
    }
  }
  return results;
}

/** Extract plain text body from message parts for triage context */
function extractBodyText(parts: GmailPart[] | undefined): string {
  if (!parts) return "";
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      const b64 = part.body.data.replace(/-/g, "+").replace(/_/g, "/");
      return atob(b64);
    }
    if (part.parts) {
      const nested = extractBodyText(part.parts);
      if (nested) return nested;
    }
  }
  return "";
}

// ── Triage ──────────────────────────────────────────────────────────────────

type TriageResult = "bill" | "payment_advice" | "customer" | "junk";

// Existing Gmail label IDs
const LABEL_BILL = "Label_5800834809592445520";
const LABEL_BILL_PAYMENT = "Label_417079469314741482";
const LABEL_INVOICE_PAYMENT = "Label_5982998896632529955";

const TRIAGE_PROMPT = `You are triaging emails sent to a food business's billing inbox (billing@thegreencart.com). Green Cart is a small food company that makes prepared meals and snacks.

Classify this email into exactly one category:

- "bill": A vendor invoice or bill for goods/services that Green Cart purchased. These are from suppliers (food ingredients, packaging, spices, equipment, etc.) and contain invoices with line items, amounts due, or attached PDF invoices. This is the primary purpose of this inbox.
- "payment_advice": A notification that a payment has been made or money has moved. Examples: transaction receipts from payment processors (Authorize.net), ACH debit confirmations, payment confirmations showing amounts charged. These tell us money left our account to pay vendor bills. NOT an invoice requesting payment.
- "customer": A message from a customer, café partner, or delivery location about orders, complaints, missing items, quality issues, delivery problems, etc. These should go to the customer service team.
- "junk": Status notifications that don't indicate money moved (e.g. "payment is on its way", "payment initiated"), QBO alerts, bank statements, marketing, newsletters, spam, Ramp notifications, or anything that doesn't fit the above categories.

Respond with ONLY the category word, nothing else.`;

async function triageEmail(
  anthropicApiKey: string,
  from: string,
  subject: string,
  bodySnippet: string,
  hasAttachments: boolean,
): Promise<TriageResult> {
  const emailSummary =
    `From: ${from}\nSubject: ${subject}\nHas attachments: ${hasAttachments}\n\nBody preview:\n${bodySnippet.slice(0, 500)}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [
        { role: "user", content: `${TRIAGE_PROMPT}\n\n---\n\n${emailSummary}` },
      ],
    }),
  });

  const msg = await resp.json();
  const text = msg.content?.[0]?.text?.trim().toLowerCase() || "junk";
  if (["bill", "payment_advice", "customer", "junk"].includes(text)) {
    return text as TriageResult;
  }
  return "junk";
}

// ── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const googleToken = await getGoogleAccessToken();
    const genieFolderId = Deno.env.get("GOOGLE_DRIVE_GENIE_FOLDER_ID")!;
    // Email-sourced bills bypass the classifier (Gmail label is authoritative)
    // and land directly in /genie/bills/processed/YYYY/ or /genie/bills/errors/.
    const billsFolderId = await getOrCreateSubfolder(googleToken, genieFolderId, "bills");
    const processedRootId = await getOrCreateSubfolder(googleToken, billsFolderId, "processed");
    const processedFolderId = await getOrCreateSubfolder(
      googleToken,
      processedRootId,
      String(new Date().getUTCFullYear()),
    );
    const errorsFolderId = await getOrCreateSubfolder(googleToken, billsFolderId, "errors");

    // 1. List unread messages
    const messageStubs = await listUnreadMessages(googleToken);
    if (messageStubs.length === 0) {
      return new Response(
        JSON.stringify({ message: "No unread emails", results: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Load vendors for bill matching
    const { data: dbVendors } = await sb
      .from("vendors")
      .select("id, qbo_vendor_id, name");
    const vendorList = dbVendors || [];

    // QBO is best-effort for intake dedupe; if init fails, we still stage bills.
    let qbo: QBOClient | null = null;
    try {
      const candidate = new QBOClient(sb);
      await candidate.init();
      qbo = candidate;
    } catch (e) {
      console.warn("[scan-email] QBO unavailable, skipping intake dedupe:", e);
    }

    const results: {
      email: string;
      category: string;
      action: string;
      bills: number[];
      errors: string[];
    }[] = [];

    for (const stub of messageStubs) {
      const msg = await getMessage(googleToken, stub.id);
      const from = getHeader(msg, "From");
      const subject = getHeader(msg, "Subject");
      const to = getHeader(msg, "To");
      const cc = getHeader(msg, "Cc");
      const bodyText = extractBodyText(msg.payload.parts);
      const attachments = collectAttachments(msg.payload.parts);

      const emailResult: {
        email: string;
        category: string;
        action: string;
        bills: number[];
        errors: string[];
      } = {
        email: `${subject} (from ${from})`,
        category: "",
        action: "",
        bills: [],
        errors: [],
      };

      // 3. Check for pre-existing Gmail labels before calling triage
      const labels = msg.labelIds || [];
      let category: TriageResult;

      if (labels.includes(LABEL_BILL)) {
        category = "bill";
      } else if (labels.includes(LABEL_BILL_PAYMENT)) {
        category = "payment_advice";
      } else if (labels.includes(LABEL_INVOICE_PAYMENT)) {
        // AR inbound payments — not our concern, archive
        category = "junk";
      } else {
        // No pre-existing label — run AI triage
        category = await triageEmail(
          anthropicApiKey,
          from,
          subject,
          bodyText,
          attachments.length > 0,
        );
      }
      emailResult.category = category;

      const hasBillLabel = labels.includes(LABEL_BILL);

      switch (category) {
        case "bill": {
          // Check if already processed
          const { data: existing } = await sb
            .from("bills")
            .select("id")
            .eq("email_message_id", stub.id);
          if (existing && existing.length > 0) {
            emailResult.action = "already_processed";
            await markBillEmailHandled(googleToken, stub.id, hasBillLabel);
            break;
          }

          if (attachments.length === 0) {
            emailResult.action = "bill_no_attachment";
            await markAsRead(googleToken, stub.id);
            break;
          }

          // Extract and stage each attachment
          for (const att of attachments) {
            try {
              const fileBytes = await getAttachment(
                googleToken,
                stub.id,
                att.attachmentId,
              );
              const invoices = await extractInvoice(
                fileBytes,
                att.mimeType,
                anthropicApiKey,
              );
              for (const extracted of invoices) {
                const staged = await stageBill(
                  sb,
                  extracted,
                  vendorList,
                  "email",
                  {
                    email_message_id: stub.id,
                    email_from: from,
                    email_subject: subject,
                  },
                  { qboClient: qbo ?? undefined },
                );
                if (staged.billId) {
                  emailResult.bills.push(staged.billId);
                  // Archive attachment to Processed folder
                  const vendor = (extracted.vendor_name as string) || "Unknown";
                  const inv = (extracted.invoice_number as string) || "no-inv";
                  const ext = att.filename.includes(".") ? att.filename.slice(att.filename.lastIndexOf(".")) : ".pdf";
                  const archiveName = `${vendor} - ${inv} (from email)${ext}`;
                  await uploadFile(googleToken, fileBytes, archiveName, att.mimeType, processedFolderId);
                } else if (staged.error) {
                  emailResult.errors.push(staged.error);
                  // Archive to Errors folder
                  const errName = `${att.filename.replace(/\.[^.]+$/, "")} (from email)${att.filename.includes(".") ? att.filename.slice(att.filename.lastIndexOf(".")) : ""}`;
                  await uploadFile(googleToken, fileBytes, errName, att.mimeType, errorsFolderId);
                }
              }
            } catch (e) {
              emailResult.errors.push(`Attachment ${att.filename}: ${e}`);
              // Try to save to Errors — best effort
              try {
                const fileBytes = await getAttachment(googleToken, stub.id, att.attachmentId);
                const errName = `${att.filename.replace(/\.[^.]+$/, "")} (from email)${att.filename.includes(".") ? att.filename.slice(att.filename.lastIndexOf(".")) : ""}`;
                await uploadFile(googleToken, fileBytes, errName, att.mimeType, errorsFolderId);
              } catch { /* best effort */ }
            }
          }

          emailResult.action = `staged_${emailResult.bills.length}_bills`;
          // Archive + ensure `bill` label is applied. Keeps the inbox clean and
          // discoverable via the label sidebar; nothing is lost from Gmail.
          if (emailResult.bills.length > 0) {
            await markBillEmailHandled(googleToken, stub.id, hasBillLabel);
          } else {
            // No bills successfully staged (extraction error etc.) — leave in
            // inbox for human follow-up, just mark read.
            await markAsRead(googleToken, stub.id);
          }
          break;
        }

        case "payment_advice": {
          // Apply "bill payment" label, mark as read — stays visible for future payment recording
          const addLabels: string[] = [];
          if (!labels.includes(LABEL_BILL_PAYMENT)) {
            addLabels.push(LABEL_BILL_PAYMENT);
          }
          await fetch(`${GMAIL_BASE}/messages/${stub.id}/modify`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${googleToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              addLabelIds: addLabels.length > 0 ? addLabels : undefined,
              removeLabelIds: ["UNREAD"],
            }),
          });
          emailResult.action = "labeled_bill_payment";
          break;
        }

        case "customer": {
          // If info@ is already on the thread, just archive
          const allRecipients = `${to} ${cc}`.toLowerCase();
          if (allRecipients.includes("info@thegreencart.com")) {
            emailResult.action = "archived_info_already_recipient";
          } else {
            await forwardToInfo(googleToken, stub.id, subject, from);
            emailResult.action = "forwarded_to_info";
          }
          await archiveMessage(googleToken, stub.id);
          break;
        }

        case "junk":
        default: {
          emailResult.action = "archived";
          await archiveMessage(googleToken, stub.id);
          break;
        }
      }

      results.push(emailResult);
    }

    const bills = results.reduce((sum, r) => sum + r.bills.length, 0);
    const payments = results.filter((r) => r.category === "payment_advice").length;
    const forwarded = results.filter((r) => r.category === "customer").length;
    const junked = results.filter((r) => r.category === "junk").length;

    return new Response(
      JSON.stringify({
        message: `Processed ${messageStubs.length} email(s): ${bills} bill(s) staged, ${payments} payment advice(s) labeled, ${forwarded} forwarded to info@, ${junked} archived`,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[scan-email]", e);
    captureEdgeError("scan-email", e);
    await flushSentry();
    return new Response(
      JSON.stringify({ error: `${e}` }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
