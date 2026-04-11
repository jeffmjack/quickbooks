import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Google Drive helpers ────────────────────────────────────────────────────

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
  if (!data.access_token) throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function listGenieFiles(token: string, folderId: string) {
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and (mimeType='application/pdf' or mimeType contains 'image/')`
  );
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  return data.files || [];
}

async function downloadFile(token: string, fileId: string): Promise<ArrayBuffer> {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.arrayBuffer();
}

// ── Claude extraction ───────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `This scan may contain one or more separate vendor invoices/bills on different pages.

Return a JSON array — one object per distinct invoice. If pages belong to the same invoice (e.g. page 2 continues page 1's line items), combine them into one object. If a new vendor header/invoice number appears, start a new object.

Each object must have exactly this structure:
{
  "vendor_name": "exact vendor name from invoice",
  "invoice_number": "invoice or order number",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD or null",
  "total_amount": 0.00,
  "line_items": [
    {
      "line_number": 1,
      "description": "exact product description from invoice",
      "sku": "product code/SKU or null",
      "quantity": 0.0,
      "unit": "unit of measure or null",
      "unit_price": 0.00,
      "extended_price": 0.00
    }
  ],
  "confidence": 0.0-1.0
}

Return only valid JSON (an array), no other text.`;

async function extractInvoice(
  fileBytes: ArrayBuffer,
  mimeType: string
): Promise<Record<string, unknown>[]> {
  const b64 = btoa(
    new Uint8Array(fileBytes).reduce((s, b) => s + String.fromCharCode(b), "")
  );

  // Map MIME types for Claude
  let mediaType = mimeType;
  if (mediaType === "application/pdf") mediaType = "application/pdf";
  else if (mediaType.startsWith("image/")) { /* keep as-is */ }
  else mediaType = "image/jpeg"; // fallback

  const sourceType = mediaType === "application/pdf" ? "document" : "image";

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          {
            type: sourceType,
            source: { type: "base64", media_type: mediaType, data: b64 },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const msg = await resp.json();
  if (!resp.ok) throw new Error(`Claude API error: ${JSON.stringify(msg)}`);

  let text = msg.content[0].text.trim();
  if (text.startsWith("```")) {
    text = text.split("```")[1];
    if (text.startsWith("json")) text = text.slice(4);
  }
  const result = JSON.parse(text.trim());
  return Array.isArray(result) ? result : [result];
}

// ── Vendor matching ─────────────────────────────────────────────────────────

function similarity(a: string, b: string): number {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  if (al === bl) return 1;
  const longer = al.length > bl.length ? al : bl;
  const shorter = al.length > bl.length ? bl : al;
  if (longer.length === 0) return 1;
  // Simple Levenshtein-based similarity
  const costs: number[] = [];
  for (let i = 0; i <= longer.length; i++) {
    let lastVal = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i === 0) { costs[j] = j; continue; }
      if (j > 0) {
        let newVal = costs[j - 1];
        if (longer[i - 1] !== shorter[j - 1]) {
          newVal = Math.min(newVal, lastVal, costs[j]) + 1;
        }
        costs[j - 1] = lastVal;
        lastVal = newVal;
      }
    }
    if (i > 0) costs[shorter.length] = lastVal;
  }
  return (longer.length - costs[shorter.length]) / longer.length;
}

// ── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const genieFolderId = Deno.env.get("GOOGLE_DRIVE_GENIE_FOLDER_ID")!;

    // 1. Get Google access token
    const googleToken = await getGoogleAccessToken();

    // 2. List files in Genie folder
    const files = await listGenieFiles(googleToken, genieFolderId);
    if (files.length === 0) {
      return new Response(
        JSON.stringify({ message: "Genie folder is empty", bills: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Filter out already-staged files
    const newFiles = [];
    for (const f of files) {
      const { data } = await sb
        .from("bills")
        .select("id, status")
        .eq("drive_file_id", f.id);
      if (data && data.length > 0) continue;
      newFiles.push(f);
    }

    if (newFiles.length === 0) {
      return new Response(
        JSON.stringify({ message: "No new files to process", bills: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Load QBO vendors from DB for matching
    const { data: dbVendors } = await sb
      .from("vendors")
      .select("id, qbo_vendor_id, name");
    const vendorList = dbVendors || [];

    // 5. Process each file
    const results: { file: string; bills: number[]; errors: string[] }[] = [];

    for (const f of newFiles) {
      const fileResult: { file: string; bills: number[]; errors: string[] } = {
        file: f.name,
        bills: [],
        errors: [],
      };

      try {
        const fileBytes = await downloadFile(googleToken, f.id);
        const invoices = await extractInvoice(fileBytes, f.mimeType);

        for (const extracted of invoices) {
          const vendorName = (extracted.vendor_name as string) || "Unknown";

          // Find best matching vendor in DB
          let vendorDbId: number | null = null;
          let bestScore = 0;
          for (const v of vendorList) {
            const score = similarity(vendorName, v.name);
            if (score > bestScore) {
              bestScore = score;
              vendorDbId = v.id;
            }
          }

          // If no good match, create a new vendor record
          if (bestScore < 0.6 || vendorDbId === null) {
            const { data: newVendor } = await sb
              .from("vendors")
              .insert({ name: vendorName, short_name: vendorName.split(" ")[0] })
              .select("id")
              .single();
            if (newVendor) {
              vendorDbId = newVendor.id;
              vendorList.push({ id: newVendor.id, qbo_vendor_id: null, name: vendorName });
            }
          }

          // Look up mappings for each line item
          const lineItems = (extracted.line_items as Record<string, unknown>[]) || [];
          const lineMappings: { mapping_id: number | null; acct_db_id: number | null; confidence: number }[] = [];

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
                  conf = Math.round(bestDescScore * bestRow.confidence * 100) / 100;
                }
              }
            }

            lineMappings.push({ mapping_id: mappingId, acct_db_id: acctDbId, confidence: conf });
          }

          // Stage the bill
          const { data: billData, error: billError } = await sb
            .from("bills")
            .insert({
              vendor_id: vendorDbId,
              invoice_number: extracted.invoice_number || null,
              invoice_date: extracted.invoice_date || null,
              due_date: extracted.due_date || null,
              total_amount: extracted.total_amount || null,
              drive_file_id: f.id,
              drive_file_name: f.name,
              source: "genie",
              status: "pending",
              raw_extraction: extracted,
            })
            .select("id")
            .single();

          if (billError || !billData) {
            fileResult.errors.push(`Failed to insert bill: ${billError?.message}`);
            continue;
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

          fileResult.bills.push(billDbId);
        }
      } catch (e) {
        fileResult.errors.push(`${e}`);
      }

      results.push(fileResult);
    }

    const totalBills = results.reduce((sum, r) => sum + r.bills.length, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    return new Response(
      JSON.stringify({
        message: `Processed ${newFiles.length} file(s): ${totalBills} bill(s) staged, ${totalErrors} error(s)`,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `${e}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
