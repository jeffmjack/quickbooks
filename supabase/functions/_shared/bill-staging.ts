// Shared bill staging logic: vendor matching, line item mapping, DB insertion

import { similarity } from "./extraction.ts";

type SupabaseClient = {
  from: (table: string) => any;
};

type VendorRow = { id: number; qbo_vendor_id: string | null; name: string };

type ExtractedInvoice = Record<string, unknown>;

type StagedResult = {
  billId: number | null;
  error: string | null;
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

  // Insert the bill
  const { data: billData, error: billError } = await sb
    .from("bills")
    .insert({
      vendor_id: vendorDbId,
      invoice_number: extracted.invoice_number || null,
      invoice_date: extracted.invoice_date || null,
      due_date: extracted.due_date || null,
      total_amount: extracted.total_amount || null,
      drive_file_id: fileRef.drive_file_id || null,
      drive_file_name: fileRef.drive_file_name || null,
      email_message_id: fileRef.email_message_id || null,
      email_from: fileRef.email_from || null,
      email_subject: fileRef.email_subject || null,
      source,
      status: "pending",
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

  return { billId: billDbId, error: null };
}
