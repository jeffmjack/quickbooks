// Shared bill staging logic: vendor matching, line item mapping, DB insertion.
//
// Intake dedupe runs in two layers:
//   1. Same-doc-twice — same (vendor, invoice_number) already exists in Supabase.
//      If totals + dates match, the new arrival is marked `ignored` pointing at the
//      original. If they diverge, both rows stay pending and the new one carries a
//      "Review needed: possible duplicate of #X" warning.
//   2. Already-in-QBO — a Bill with same DocNumber + VendorRef exists in QBO
//      (e.g. bookkeeper-keyed vendors like MYR). Marked `ignored` with qbo_bill_id
//      stamped to the matched QBO Bill. Only runs when a QBOClient is passed in
//      and the vendor is linked.

import { similarity, validateExtraction } from "./extraction.ts";
import { QBOClient } from "./qbo-client.ts";

type SupabaseClient = {
  from: (table: string) => any;
};

type VendorRow = { id: number; qbo_vendor_id: string | null; name: string };

type ExtractedInvoice = Record<string, unknown>;

type StagedResult = {
  billId: number | null;
  error: string | null;
};

type StageOptions = {
  /** When set, intake checks QBO for an existing Bill and auto-marks dupes as `ignored`. */
  qboClient?: QBOClient;
};

export async function stageBill(
  sb: SupabaseClient,
  extracted: ExtractedInvoice,
  vendorList: VendorRow[],
  source: string,
  fileRef: {
    drive_file_id?: string | null;
    drive_file_name?: string | null;
    email_message_id?: string | null;
    email_from?: string | null;
    email_subject?: string | null;
  },
  opts: StageOptions = {},
): Promise<StagedResult> {
  const vendorName = (extracted.vendor_name as string) || "Unknown";

  // Find best matching vendor
  let vendorDbId: number | null = null;
  let bestScore = 0;
  for (const v of vendorList) {
    const score = similarity(vendorName, v.name);
    if (score > bestScore) {
      bestScore = score;
      vendorDbId = v.id;
    }
  }

  // Create new vendor if no good match
  if (bestScore < 0.6 || vendorDbId === null) {
    const { data: newVendor } = await sb
      .from("vendors")
      .insert({ name: vendorName, short_name: vendorName.split(" ")[0] })
      .select("id")
      .single();
    if (newVendor) {
      vendorDbId = newVendor.id;
      vendorList.push({
        id: newVendor.id,
        qbo_vendor_id: null,
        name: vendorName,
      });
    }
  }

  // Look up mappings for each line item
  const lineItems = (extracted.line_items as Record<string, unknown>[]) || [];
  const lineMappings: {
    mapping_id: number | null;
    acct_db_id: number | null;
    confidence: number;
  }[] = [];

  for (const item of lineItems) {
    const desc = (item.description as string) || "";
    const sku = item.sku as string | null;

    let mappingId: number | null = null;
    let acctDbId: number | null = null;
    let conf = 0;

    // Try SKU match first
    if (sku && vendorDbId) {
      const { data: skuMatch } = await sb
        .from("vendor_item_mappings")
        .select("id, qbo_account_id, confidence")
        .eq("vendor_id", vendorDbId)
        .eq("item_sku", sku)
        .limit(1);
      if (skuMatch && skuMatch.length > 0) {
        mappingId = skuMatch[0].id;
        acctDbId = skuMatch[0].qbo_account_id;
        conf = skuMatch[0].confidence;
      }
    }

    // Try description match if no SKU match
    if (!mappingId && vendorDbId) {
      const { data: descMappings } = await sb
        .from("vendor_item_mappings")
        .select("id, qbo_account_id, confidence, item_description")
        .eq("vendor_id", vendorDbId);

      if (descMappings && descMappings.length > 0) {
        let bestRow = null;
        let bestDescScore = 0;
        for (const row of descMappings) {
          const score = similarity(desc, row.item_description);
          if (score > bestDescScore) {
            bestRow = row;
            bestDescScore = score;
          }
        }
        if (bestDescScore >= 0.75 && bestRow) {
          mappingId = bestRow.id;
          acctDbId = bestRow.qbo_account_id;
          conf =
            Math.round(bestDescScore * bestRow.confidence * 100) / 100;
        }
      }
    }

    lineMappings.push({
      mapping_id: mappingId,
      acct_db_id: acctDbId,
      confidence: conf,
    });
  }

  // Cross-check extraction arithmetic — surface OCR errors / missing surcharges
  // as warnings instead of silently posting a wrong total to QBO later.
  const warnings = validateExtraction(extracted);
  const warningMessage = warnings.length
    ? "Review needed: " + warnings.map((w) => w.message).join(" | ")
    : null;

  // Layer 1: same-doc-twice check (Supabase-side). Surfaces the Segovia 01344850
  // pattern where the same paper invoice gets dropped into /genie twice.
  const invoiceNumber = (extracted.invoice_number as string | null) || null;
  const invoiceDate = (extracted.invoice_date as string | null) || null;
  const totalAmount =
    typeof extracted.total_amount === "number"
      ? extracted.total_amount
      : extracted.total_amount != null
      ? Number(extracted.total_amount)
      : null;

  let sameDocDupId: number | null = null;
  let sameDocMismatchNote: string | null = null;

  if (vendorDbId !== null && invoiceNumber) {
    const { data: priorBills } = await sb
      .from("bills")
      .select("id, total_amount, invoice_date, status")
      .eq("vendor_id", vendorDbId)
      .eq("invoice_number", invoiceNumber)
      .neq("status", "error")
      .order("id", { ascending: true })
      .limit(5);

    if (priorBills && priorBills.length > 0) {
      const orig = priorBills[0];
      const priorTotal = orig.total_amount != null ? Number(orig.total_amount) : null;
      const totalsMatch =
        totalAmount != null &&
        priorTotal != null &&
        Math.abs(priorTotal - totalAmount) < 0.02;
      const datesMatch =
        (orig.invoice_date ?? null) === (invoiceDate ?? null);

      if (totalsMatch && datesMatch) {
        sameDocDupId = orig.id;
      } else {
        sameDocMismatchNote =
          `Possible duplicate of bill #${orig.id} ` +
          `(prior: $${priorTotal} on ${orig.invoice_date ?? "?"}; ` +
          `this: $${totalAmount} on ${invoiceDate ?? "?"}) — review`;
      }
    }
  }

  // Decide initial status + error_message before insert.
  let initialStatus = "pending";
  const messages: string[] = [];
  if (warningMessage) messages.push(warningMessage);
  if (sameDocDupId !== null) {
    initialStatus = "ignored";
    messages.unshift(
      `Same-doc duplicate of bill #${sameDocDupId}. Auto-ignored at intake.`,
    );
  } else if (sameDocMismatchNote) {
    messages.push("Review needed: " + sameDocMismatchNote);
  }
  const initialErrorMessage = messages.length ? messages.join(" | ") : null;

  // Insert the bill
  const { data: billData, error: billError } = await sb
    .from("bills")
    .insert({
      vendor_id: vendorDbId,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      due_date: extracted.due_date || null,
      total_amount: extracted.total_amount || null,
      drive_file_id: fileRef.drive_file_id || null,
      drive_file_name: fileRef.drive_file_name || null,
      email_message_id: fileRef.email_message_id || null,
      email_from: fileRef.email_from || null,
      email_subject: fileRef.email_subject || null,
      source,
      status: initialStatus,
      error_message: initialErrorMessage,
      raw_extraction: extracted,
    })
    .select("id")
    .single();

  if (billError || !billData) {
    return { billId: null, error: `Failed to insert bill: ${billError?.message}` };
  }

  const billDbId = billData.id;

  // Insert line items
  for (let j = 0; j < lineItems.length; j++) {
    const item = lineItems[j];
    const mapping = lineMappings[j];
    await sb.from("bill_line_items").insert({
      bill_id: billDbId,
      line_number: (item.line_number as number) || j + 1,
      description: item.description || null,
      sku: item.sku || null,
      quantity: item.quantity || null,
      unit: item.unit || null,
      unit_price: item.unit_price || null,
      extended_price: item.extended_price || null,
      qbo_account_id: mapping.acct_db_id,
      mapping_id: mapping.mapping_id,
      mapping_confidence: mapping.confidence,
    });
  }

  // Layer 2: QBO-side dedupe. Skip if we already ignored as a same-doc dup, or
  // if the vendor isn't linked to QBO (no way to query). Best-effort: a QBO
  // query failure here should not fail the whole intake — just log and continue.
  if (initialStatus !== "ignored" && opts.qboClient) {
    const vendor = vendorList.find((v) => v.id === vendorDbId);
    const qboVendorId = vendor?.qbo_vendor_id ?? null;
    if (qboVendorId) {
      try {
        const existing = await opts.qboClient.findBill(
          qboVendorId,
          invoiceNumber,
          invoiceDate,
          totalAmount,
        );
        if (existing) {
          const note =
            `Already in QBO as Bill ${existing.Id} ` +
            `(DocNum=${existing.DocNumber ?? "N/A"}, $${existing.TotalAmt}, ${existing.TxnDate}, ` +
            `balance $${existing.Balance ?? "?"}). Auto-ignored at intake.`;
          const merged = initialErrorMessage
            ? `${note} | ${initialErrorMessage}`
            : note;
          await sb
            .from("bills")
            .update({
              status: "ignored",
              qbo_bill_id: existing.Id,
              error_message: merged,
            })
            .eq("id", billDbId);
        }
      } catch (e) {
        console.warn(`[stageBill] QBO dedupe check failed for bill #${billDbId}:`, e);
      }
    }
  }

  return { billId: billDbId, error: null };
}
