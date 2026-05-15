import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractInvoice } from "../_shared/extraction.ts";
import { stageBill } from "../_shared/bill-staging.ts";
import { QBOClient } from "../_shared/qbo-client.ts";
import {
  getOrCreateSubfolder,
  listFolderFiles,
  downloadFile,
  moveFile,
  splitFilename,
} from "../_shared/drive.ts";
import { captureEdgeError, flushSentry } from "../_shared/sentry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    const googleToken = await getGoogleAccessToken();

    // Folder layout: /genie/bills/ → /genie/bills/processed/YYYY/ or /genie/bills/errors/
    const billsFolderId = await getOrCreateSubfolder(googleToken, genieFolderId, "bills");
    const processedFolderId = await getOrCreateSubfolder(googleToken, billsFolderId, "processed");
    const errorsFolderId = await getOrCreateSubfolder(googleToken, billsFolderId, "errors");
    const yearFolderId = await getOrCreateSubfolder(
      googleToken,
      processedFolderId,
      String(new Date().getUTCFullYear()),
    );

    const files = await listFolderFiles(googleToken, billsFolderId);
    if (files.length === 0) {
      return new Response(
        JSON.stringify({ message: "/genie/bills/ is empty", bills: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Filter out already-staged files (idempotent re-scan)
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

    // Load vendors for matching
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
      console.warn("[scan-genie] QBO unavailable, skipping intake dedupe:", e);
    }

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
          const staged = await stageBill(
            sb,
            extracted,
            vendorList,
            "genie",
            {
              drive_file_id: f.id,
              drive_file_name: f.name,
            },
            { qboClient: qbo ?? undefined },
          );

          if (staged.billId) {
            fileResult.bills.push(staged.billId);
          } else if (staged.error) {
            fileResult.errors.push(staged.error);
          }
        }

        if (fileResult.bills.length > 0) {
          const [base, ext] = splitFilename(f.name);
          await moveFile(googleToken, f.id, billsFolderId, yearFolderId, `${base} (from scan)${ext}`);
        } else if (fileResult.errors.length > 0) {
          await moveFile(googleToken, f.id, billsFolderId, errorsFolderId);
        }
      } catch (e) {
        fileResult.errors.push(`${e}`);
        try {
          await moveFile(googleToken, f.id, billsFolderId, errorsFolderId);
        } catch { /* best effort */ }
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
    console.error("[scan-genie]", e);
    captureEdgeError("scan-genie", e);
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
