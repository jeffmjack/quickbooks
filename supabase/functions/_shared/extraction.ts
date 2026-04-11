// Shared Claude invoice extraction + string similarity

export const EXTRACTION_PROMPT = `This scan may contain one or more separate vendor invoices/bills on different pages.

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

export async function extractInvoice(
  fileBytes: ArrayBuffer,
  mimeType: string,
  anthropicApiKey: string,
): Promise<Record<string, unknown>[]> {
  const b64 = btoa(
    new Uint8Array(fileBytes).reduce((s, b) => s + String.fromCharCode(b), ""),
  );

  let mediaType = mimeType;
  if (!mediaType.startsWith("image/") && mediaType !== "application/pdf") {
    mediaType = "image/jpeg";
  }

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
      "x-api-key": anthropicApiKey,
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

export function similarity(a: string, b: string): number {
  const al = a.toLowerCase(),
    bl = b.toLowerCase();
  if (al === bl) return 1;
  const longer = al.length > bl.length ? al : bl;
  const shorter = al.length > bl.length ? bl : al;
  if (longer.length === 0) return 1;
  const costs: number[] = [];
  for (let i = 0; i <= longer.length; i++) {
    let lastVal = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i === 0) {
        costs[j] = j;
        continue;
      }
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
