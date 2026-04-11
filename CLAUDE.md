# gc-finance

Internal finance ops tool for Green Cart. Not a public-facing app.
Deployed at `finance.thegreencart.com`.

## Stack

- **Frontend:** Vite + React 19 + TypeScript SPA. React Router 7, Tailwind CSS 4, shadcn/ui. Deployed on Vercel as static SPA (not Next.js — no SSR needed).
- **Backend:** Supabase (Postgres 17 + Auth + Edge Functions). Frontend talks directly to Supabase via JS client with RLS.
- **Edge functions:** Deno/TypeScript, deployed via `supabase functions deploy`. Secrets set via `supabase secrets set`.
- **Python scripts:** QBO integration, payroll, reporting. Use service role key. Run locally.
- **Auth:** Supabase email/password. No public signup. Accounts: jeff@thegreencart.com, amerykah@thegreencart.com.

## Project structure

```
app/                    # Vite React SPA
  src/
    pages/              # Bills, BOM, Financials, PayrollDashboard, Login
    components/ui/      # shadcn/ui components
    contexts/           # AuthContext
    lib/                # supabase.ts client, utils
supabase/
  functions/            # Edge functions (Deno)
    scan-genie/         # Google Drive Genie folder invoice scanner
    scan-email/         # Gmail inbox scanner with AI triage
    _shared/            # Shared modules (extraction.ts, bill-staging.ts)
  migrations/           # Postgres migrations (applied in order)
  config.toml           # Local dev config
*.py                    # QBO/payroll Python scripts (root level)
vercel.json             # Vercel deploy config (SPA rewrite)
```

## Bill ingestion

Two sources, both sharing extraction + staging logic via `_shared/`:

- **Google Drive** (`scan-genie`) — scans Genie folder for PDF/image invoices
- **Gmail** (`scan-email`) — scans billing@thegreencart.com inbox with AI triage:
  - Pre-labeled emails (from existing Gmail filters) skip AI classification
  - `bill` label → extract invoice + stage in Supabase
  - `bill payment` label → mark as read, keep labeled (future: auto-record payment in QBO)
  - `invoice payment` label → archive (AR, not AP)
  - Unlabeled emails → Haiku classifies as bill / payment_advice / customer / junk
  - Customer emails → forward to info@thegreencart.com if not already a recipient, archive
  - Junk → archive

## Key architecture decisions

- **Bills use 3 QBO categories** (Food Cost, Packaging Cost, Usage/Supplies). Detailed per-ingredient tracking lives in the BOM, not QBO.
- **Non-COGS expenses** (SaaS, legal, gas, insurance) are NOT posted as bills to QBO. They're handled via bank feed matching in QBO directly. Don't create QBO bill records for these.
- **Invoice extraction** uses Claude vision (claude-sonnet-4-6) to parse PDF/image invoices into structured JSON.
- **Email triage** uses Claude Haiku for fast/cheap classification.
- **Vendor matching** uses Levenshtein similarity (threshold 0.6). Line item mapping: SKU exact match first, then description similarity (0.75+).
- **Google OAuth** (Desktop client, refresh token) used for Drive API + Gmail API (gmail.modify scope). Token stored in `google_token.json`, re-auth via `python3 get_google_token.py`.
- **Vendor payment_notes** field stores per-vendor billing quirks (e.g. Segovia uses invoice number ranges in payment advices).

## Environment variables

- Frontend: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` in `app/.env`
- Edge functions (via `supabase secrets set`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_GENIE_FOLDER_ID`
- Python scripts: `.env` in root with QBO tokens, Supabase keys
- Vercel project linked via `vercel link --project gc-finance`

## Database tables (Supabase/Postgres)

- `bills` — vendor_id, invoice_number, dates, total_amount, drive_file_id, email_message_id, email_from, email_subject, source (genie/email), status (pending/reviewed/posted/error)
- `bill_line_items` — bill_id, description, sku, qty, prices, qbo_account_id, mapping_id, mapping_confidence
- `vendors` — name, short_name, qbo_vendor_id, vendor_type, payment_notes
- `qbo_accounts` — name, account_number, account_type (COGS/Expense). Only 3 accounts: Food Cost, Packaging Cost, Usage & Supplies
- `vendor_item_mappings` — vendor_id, item_description, item_sku, qbo_account_id, confidence (learning table for auto-mapping)
- `bom_*` tables — three-tier BOM (recipes, ingredients, products)

## Gmail labels (billing@thegreencart.com)

- `bill` (Label_5800834809592445520) — vendor invoices
- `bill payment` (Label_417079469314741482) — outbound payment advices
- `invoice payment` (Label_5982998896632529955) — inbound customer payments (AR)

## Google Drive folders

- Genie folder (env var `GOOGLE_DRIVE_GENIE_FOLDER_ID`) — invoice PDFs to scan
- Paper receipts (`1pFDsBZ2ktag8bd-RNUwNfbCyoyHwhBaO`) — filed by year subfolder, for non-COGS receipts

## Commands

- `cd app && npm run dev` — start frontend dev server (port 5173)
- `supabase start` — start local Supabase (API 54321, DB 54322, Studio 54323)
- `supabase functions serve` — serve edge functions locally
- `supabase db push` — push migrations to remote
- `supabase functions deploy scan-genie` — deploy edge function
- `supabase functions deploy scan-email` — deploy edge function
- `vercel --prod` — deploy frontend to production
- `python3 get_google_token.py` — re-auth Google OAuth (updates google_token.json)

## Conventions

- Auto-save inline edits immediately (no manual Save buttons)
- QBO token rotation is fragile — never make ad-hoc QBO API calls without persisting refreshed tokens
- Use Intuit OAuth Playground for QBO re-auth, not get_tokens.py
- This is a Vite SPA, not Next.js — ignore "use client" directive suggestions
