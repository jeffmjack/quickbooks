import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractInvoice } from "../_shared/extraction.ts";
import { stageBill } from "../_shared/bill-staging.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
  if (!data.access_token)
    throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function listGenieFiles(token: string, folderId: string) {
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and (mimeType='application/pdf' or mimeType contains 'image/')`,
  );
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await resp.json();
  return data.files || [];
}

async function downloadFile(
  token: string,
  fileId: string,
): Promise<ArrayBuffer> {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return resp.arrayBuffer();
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

    const genieFolderId = Deno.env.get("GOOGLE_DRIVE_GENIE_FOLDER_ID")!;

    // 1. Get Google access token
    const googleToken = await getGoogleAccessToken();

    // 2. List files in Genie folder
    const files = await listGenieFiles(googleToken, genieFolderId);
    if (files.length === 0) {
      return new Response(
        JSON.stringify({ message: "Genie folder is empty", bills: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 4. Load vendors for matching
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
        const invoices = await extractInvoice(fileBytes, f.mimeType, anthropicApiKey);

        for (const extracted of invoices) {
          const staged = await stageBill(sb, extracted, vendorList, "genie", {
            drive_file_id: f.id,
            drive_file_name: f.name,
          });

          if (staged.billId) {
            fileResult.bills.push(staged.billId);
          } else if (staged.error) {
            fileResult.errors.push(staged.error);
          }
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
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `${e}` }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
