// Parse Ramp notification emails (communications@ramp.com).
//
// Direction:
//   AR — customer paid Green Cart via Ramp. Becomes a QBO Receive Payment.
//   AP — Green Cart paid a vendor via Ramp. Becomes a QBO Bill Payment.
//        Detected and staged with status='ignored' for now — handled separately.
//
// Event type:
//   initiated — customer kicked off the payment; funds still in transit.
//               (Subjects: "[Instant eligible] …is on the way", "Payment from X for #N is on the way",
//                old: "Payment initiated for bill THE GREEN CART…", AP: "Bill payment initiated…")
//   delivered — Ramp has the funds and is sending them onward to our bank
//               (ACH same-day for digital; check mailed for paper).
//               (Subjects: "Payment received: #N from X", old: "Payment delivered for invoice…",
//                AP: "Bill payment delivered…")
//
// We post Receive Payments only on AR `delivered` events.
//
// Invoice number lookup priority:
//   1. Subject (when present)
//   2. Body "Vendor memo" field (`"Invoice <N>"`)
//   3. Body leading line ("…payment for #<N>")

export type RampDirection = "ar" | "ap";
export type RampEventType = "initiated" | "delivered";

export type ParsedRampEmail = {
  direction: RampDirection;
  eventType: RampEventType;
  rampPaymentId: string | null;
  payerName: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  paymentType: string | null;     // 'Check' | 'ACH'
  paymentDate: string | null;     // ISO YYYY-MM-DD
  estimatedArrival: string | null;
  traceId: string | null;
};

type SubjectClassification = {
  direction: RampDirection;
  eventType: RampEventType;
  invoiceNumber: string | null;   // null when subject doesn't carry it (Instant eligible case)
  payerName: string;
};

// ── Subject patterns ─────────────────────────────────────────────────────────
// AR — "delivered" family
const AR_DELIVERED_RECEIVED =
  /^Payment received:\s*#(?<inv>\S+)\s+from\s+(?<payer>.+?)\s*$/i;
const AR_DELIVERED_OLD_INV =
  /^Payment delivered for invoice\s+#(?<inv>\S+)\s+from\s+(?<payer>.+?)\s*$/i;
const AR_DELIVERED_OLD_BILL =
  /^Payment delivered for bill\s+THE GREEN CART,\s*LLC\s+#(?<inv>\S+)\s+from\s+(?<payer>.+?)\s*$/i;
// AR — "initiated" family
const AR_INITIATED_NEW =
  /^Payment from\s+(?<payer>.+?)\s+for\s+#(?<inv>\S+)\s+is on the way\s*$/i;
const AR_INITIATED_INSTANT =
  /^\[Instant eligible\]\s+Payment from\s+(?<payer>.+?)\s+is on the way.*$/i;
const AR_INITIATED_OLD =
  /^Payment initiated for bill\s+THE GREEN CART,\s*LLC\s+#(?<inv>\S+)\s+from\s+(?<payer>.+?)\s*$/i;
// AP — both directions of the workflow
const AP_INITIATED =
  /^The Green Cart\s+[—-]\s+Bill payment initiated:\s+(?<vendor>.+?)\s+#(?<inv>\S+)\s*$/i;
const AP_DELIVERED =
  /^The Green Cart\s+[—-]\s+Bill payment delivered:\s+(?<vendor>.+?)\s+#(?<inv>\S+)\s*$/i;

function classifyRampSubject(subject: string): SubjectClassification | null {
  const s = subject.trim();

  const tryMatch = (
    re: RegExp,
    direction: RampDirection,
    eventType: RampEventType,
    payerGroup: "payer" | "vendor",
  ): SubjectClassification | null => {
    const m = re.exec(s);
    if (!m?.groups) return null;
    return {
      direction,
      eventType,
      invoiceNumber: m.groups.inv ?? null,
      payerName: (m.groups[payerGroup] ?? "").trim(),
    };
  };

  return (
    tryMatch(AR_DELIVERED_RECEIVED, "ar", "delivered", "payer") ||
    tryMatch(AR_DELIVERED_OLD_INV, "ar", "delivered", "payer") ||
    tryMatch(AR_DELIVERED_OLD_BILL, "ar", "delivered", "payer") ||
    tryMatch(AR_INITIATED_NEW, "ar", "initiated", "payer") ||
    tryMatch(AR_INITIATED_INSTANT, "ar", "initiated", "payer") ||
    tryMatch(AR_INITIATED_OLD, "ar", "initiated", "payer") ||
    tryMatch(AP_INITIATED, "ap", "initiated", "vendor") ||
    tryMatch(AP_DELIVERED, "ap", "delivered", "vendor")
  );
}

// ── Body field extraction ────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findField(body: string, label: string): string | null {
  // Ramp formats body as `Label\n\n\nValue\n` blocks. Walk to next non-empty line.
  const re = new RegExp(
    `^\\s*${escapeRe(label)}\\s*\\n+\\s*(?<val>[^\\n]+?)\\s*$`,
    "im",
  );
  const m = re.exec(body);
  return m?.groups?.val?.trim() ?? null;
}

/** Pull invoice number from body when the subject doesn't carry it. */
function findInvoiceInBody(body: string): string | null {
  // Vendor memo: `"Invoice 50906"`. Quote characters vary; accept any.
  const memo = findField(body, "Vendor memo");
  if (memo) {
    const m = memo.match(/Invoice\s+#?(\S+?)["'”’]?\s*$/i);
    if (m) return m[1];
  }
  // Leading line: "…sent payment for #N" or "Your payment from X for #N…"
  const leading = body.match(/(?:sent payment for|payment from\s+\S.*?for)\s+#(\S+)/i);
  if (leading) return leading[1];
  return null;
}

/** "$1,400.00" → 1400 ; "—"/null → null */
function parseMoney(raw: string | null): number | null {
  if (!raw) return null;
  const stripped = raw.replace(/[\s,$]/g, "");
  if (!stripped) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

/** "Jan 14, 2026" / "January 28, 2026" → "2026-01-14" */
function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Returns null when the subject doesn't match any known Ramp pattern — caller
 * should skip those silently (not a Ramp event we model).
 */
export function parseRampEmail(subject: string, body: string): ParsedRampEmail | null {
  const cls = classifyRampSubject(subject);
  if (!cls) return null;

  const invoiceNumber = cls.invoiceNumber ?? findInvoiceInBody(body);

  return {
    direction: cls.direction,
    eventType: cls.eventType,
    rampPaymentId: findField(body, "Payment ID"),
    payerName: cls.payerName || null,
    invoiceNumber,
    amount:
      parseMoney(findField(body, "Payment amount \\(after vendor credits\\)")) ??
      parseMoney(findField(body, "Payment amount")),
    paymentType: findField(body, "Payment type"),
    paymentDate: parseDate(findField(body, "Payment date")),
    estimatedArrival: parseDate(findField(body, "Estimated arrival date")),
    traceId: findField(body, "Trace ID"),
  };
}
