# gc-finance

Internal finance ops tool for Green Cart. Not a public-facing app.
Deployed at `finance.thegreencart.com`.

## Stack

- **Frontend:** Vite + React 19 + TypeScript SPA. React Router 7, Tailwind CSS 4, shadcn/ui. Deployed on Vercel as static SPA (not Next.js — no SSR needed).
- **Backend:** Supabase (Postgres 17 + Auth + Edge Functions). Frontend talks directly to Supabase via JS client with RLS.
- **Edge functions:** Deno/TypeScript, deployed via `supabase functions deploy <name> --no-verify-jwt`. Secrets set via `supabase secrets set`.
- **Python scripts:** QBO integration, payroll, reporting. Use service role key. Run locally. Being phased out in favor of edge functions.
- **Auth:** Supabase email/password. No public signup. Accounts: jeff@thegreencart.com, amerykah@thegreencart.com.

## Project structure

```
app/                    # Vite React SPA
  src/
    pages/              # Bills, Deposits, BOM, Financials, PayrollDashboard, Login
    components/ui/      # shadcn/ui components
    contexts/           # AuthContext
    lib/                # supabase.ts client, utils
supabase/
  functions/            # Edge functions (Deno)
    classify-genie/     # Routes /genie/ root inbox into category subfolders via Haiku
    scan-genie/         # Picks up /genie/bills/, extracts + stages COGS bills
    scan-email/         # Gmail inbox scanner with AI triage; bills land in /genie/bills/processed/
    scan-deposits/      # Picks up /genie/check-stubs/, extracts + stages AR deposits
    scan-ramp/          # Gmail intake for Ramp AR notifications → ramp_payments table
    post-bill/          # Post staged bill to QBO
    post-ramp-payment/  # Post staged Ramp `delivered` events to QBO as Receive Payments
    sync-vendors/       # Sync QBO vendor list into Supabase
    link-vendor/        # Link/merge Supabase vendor to QBO vendor, or create new
    _shared/            # Shared modules
      extraction.ts         # Claude vision invoice extraction
      deposit-extraction.ts # Single Claude call: classify + extract Chase summary + N stubs
      bill-staging.ts       # Vendor matching + line item mapping + DB insertion (incl. dedupe layers)
      ramp-parser.ts        # Parse Ramp notification email subjects + bodies (AR + AP)
      qbo-client.ts         # Centralized QBO OAuth + API client (THE one place for QBO auth)
      drive.ts              # Google Drive file management (move, upload, subfolder creation)
      sentry.ts             # Minimal Sentry wiring — captureEdgeError + captureEdgeMessage + flushSentry (no-op if DSN unset)
  migrations/           # Postgres migrations (applied in order)
  config.toml           # Local dev config
*.py                    # QBO/payroll Python scripts (root level, being phased out)
vercel.json             # Vercel deploy config (SPA rewrite)
```

## Document intake pipeline

All scanned/uploaded paper enters via the **`/genie/` Drive folder** (root inbox). The pipeline is:

1. **`classify-genie`** (cron `*/15`) — Haiku classifies each file directly in `/genie/` root into one of `bill`, `check_stubs`, `haccp`, `payment_advice`, or `other`. Routes to `/genie/<category>/`. Low-confidence (<0.6) goes to `/genie/other/`.
2. **`scan-genie`** (cron `*/15` + 2min lag) — picks up `/genie/bills/`, extracts via Claude Sonnet vision, stages bills, moves to `/genie/bills/processed/YYYY/` with `(from scan)` suffix or `/genie/bills/errors/` on failure.
3. **`scan-deposits`** (cron `*/15` + 2min lag) — picks up `/genie/check-stubs/`, extracts deposit data (Chase summary + stubs), matches invoices, moves to `/genie/check-stubs/processed/YYYY/` with `(deposit)` suffix or `/genie/check-stubs/errors/` on failure.
4. **`scan-email`** (cron `*/15` + 5min lag) — independent Gmail flow. Bills extracted from email attachments **bypass the classifier** (Gmail label is authoritative) and write directly to `/genie/bills/processed/YYYY/` with `(from email)` suffix.

### scan-email triage details

- Pre-labeled emails (from existing Gmail filters) skip AI classification
- `bill` label → extract invoice + stage in Supabase, upload attachment to `/genie/bills/processed/YYYY/` with `(from email)` suffix
- `bill payment` label → mark as read, keep labeled (future: auto-record payment in QBO)
- `invoice payment` label → archive (AR, not AP)
- Unlabeled emails → Haiku classifies as bill / payment_advice / customer / junk
- Customer emails → forward to info@thegreencart.com if not already a recipient, archive
- Junk → archive

## Deposit ingestion

Mailed-check deposits (AR side). Single multi-page PDF per deposit — Chase deposit summary + N customer remittance stubs scanned together.

- **Drive intake:** `/genie/check-stubs/<timestamp>.pdf` — classify-genie routes deposit scans here from `/genie/` root.
- **Pipeline (`scan-deposits`):** one Claude vision call extracts `{ chase, stubs[] }` → inserts a `deposits` row + N `deposit_stubs` rows → invoice-first QBO matching (each invoice number looked up globally; customer derived from CustomerRef; payer-name + check-date tiebreakers when DocNumbers collide) → moves the file to `/genie/check-stubs/processed/YYYY/` with `(deposit)` suffix (or `/genie/check-stubs/errors/` on failure). Idempotent on `drive_file_id`.
- **Reconciliation:** `sum(stubs.amount)` vs `chase_total`, $0.02 tolerance. Statuses: `pending|matched|mismatch|no_chase|no_stubs`.
- **Per-stub `match_status`:** `matched` (all invoices resolve to one customer), `partial` (some refs unresolved/ambiguous), `split` (invoices span multiple QBO customer entities — one stub will need N Receive Payments), `unmatched`, `customer_unknown`.
- **Review:** human-only for now. QBO Deposit posting is not built (Issue #17) — record deposits directly in QBO until that ships.

## Ramp AR pipeline

Ramp emails `billing@thegreencart.com` whenever a customer pays Green Cart via Ramp (ACH or check). We stage every event and auto-post `delivered` events to QBO as Receive Payments.

- **Intake (`scan-ramp`, cron `:07/:22/:37/:52`):** queries Gmail by sender (`from:communications@ramp.com newer_than:30d`) — label-agnostic because Gmail's filter strips UNREAD on these. Parses subject + body via `_shared/ramp-parser.ts`, upserts into `ramp_payments` keyed by Ramp Payment ID. Ramp re-sends same event with different Gmail message IDs (~50% dup rate) — DB UNIQUE on `ramp_payment_id` is the idempotency boundary.
- **Subject patterns parsed** (AR and AP, multiple historic + current Ramp formats): see `_shared/ramp-parser.ts`. Unrecognized subjects fire a Sentry warning via `captureEdgeMessage` so we notice when Ramp changes their language (already happened twice).
- **Posting (`post-ramp-payment`, cron `:09/:24/:39/:54`):** picks up `direction='ar' AND event_type='delivered' AND status='pending'` rows. Resolves invoice by global DocNumber (same pattern as scan-deposits), validates exactly-one-open-invoice + amount-equals-balance within $0.01, posts Receive Payment to **Undeposited Funds (account 36)** with `PaymentRefNum = ramp_payment_id`. QBO-side dedupe via `findReceivePaymentByRefNum` before each post — retry-safe.
- **Failure modes route to `review`**, not `error`: closed invoice ("already paid in QBO"), amount mismatch, ambiguous DocNumber, missing invoice. Reviewer reads `error_message` and decides.
- **Out of scope (today):** check-rail Ramp payments — Ramp doesn't fire `delivered` for mailed checks. Phase 3 (Issue TBD) will auto-close on `is on the way` initiated events. AP events are recognized and parked with `status='ignored'`.
- **Dry-run mode:** `POST { dryRun: true }` to `post-ramp-payment` simulates without QBO or Supabase writes. Use to vet logic against staged rows before going live.

## QBO integration

- **Centralized OAuth:** `_shared/qbo-client.ts` is the single point of contact for all QBO API calls. Refresh token stored in `qbo_tokens` table (singleton row), not `.env`. Token rotation persisted to DB automatically.
- **Bill posting:** `post-bill` edge function validates bill, checks for duplicates in QBO (by invoice # + vendor, or date + amount), posts via QBO Bill API with `AccountBasedExpenseLineDetail`.
- **Vendor sync:** `sync-vendors` pulls all QBO vendors into the `vendors` table. `link-vendor` links/merges Supabase vendors to QBO vendors or creates new ones.
- **Dupe detection:** Before posting, checks QBO for existing bill by DocNumber+Vendor, then falls back to Vendor+Date+Amount.
- **Re-auth:** Use Intuit OAuth Playground to get new refresh token, then update `qbo_tokens` table.

## Key architecture decisions

- **Bills use 3 QBO categories** posted to interim "from Claude" accounts under Wholesale COGS. Detailed per-ingredient tracking lives in the BOM, not QBO. Plan to consolidate to flat COGS > Food/Packaging/Labor structure (see memory for transition plan).
- **Non-COGS expenses** (SaaS, legal, gas, insurance) are NOT posted as bills to QBO. They're handled via bank feed matching in QBO directly. Don't create QBO bill records for these.
- **Invoice extraction** uses Claude vision (claude-sonnet-4-6) to parse PDF/image invoices into structured JSON.
- **Email triage** uses Claude Haiku for fast/cheap classification.
- **Vendor matching** uses Levenshtein similarity (threshold 0.6). Line item mapping: SKU exact match first, then description similarity (0.75+).
- **Google OAuth** (Desktop client, refresh token) used for Drive API + Gmail API (gmail.modify scope). Token stored in `google_token.json`, re-auth via `python3 get_google_token.py`.
- **Vendor payment_notes** field stores per-vendor billing quirks (e.g. Segovia uses invoice number ranges in payment advices).
- **Drive is the document archive.** All invoice files end up in `/genie/bills/processed/YYYY/` regardless of source (scan or email). Supabase stores extracted data and processing state, Drive stores the actual documents.
- **Bill staging cross-checks line-item sum vs printed subtotal/total.** Mismatches > $0.05 populate `bills.error_message` with `"Review needed: …"`; `post-bill` refuses to post until the warning is cleared (set `error_message` to null or move status to `reviewed`). Catches OCR errors and missing surcharge lines before they hit QBO and the bank feed.

## Environment variables

- Frontend (Vercel + `app/.env`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- Edge functions (via `supabase secrets set`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_GENIE_FOLDER_ID`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `SENTRY_DSN_EDGE` (optional), `SENTRY_ENVIRONMENT` (optional, defaults to "production")
- QBO refresh token + realm ID: stored in `qbo_tokens` table, NOT in env vars
- Python scripts: `.env` in root with QBO tokens, Supabase keys (legacy)

## Observability

- **Sentry:** Edge functions capture errors via `_shared/sentry.ts` into the same Sentry project as thegreencart-admin (under the-green-cart org). Events auto-tagged `service=gc-finance` for filtering in the shared issue stream. Import `captureEdgeError` + `flushSentry` in the outer catch of every function. No-op if `SENTRY_DSN_EDGE` unset — safe to deploy code before the secret is configured.
- **Scheduled scanning:** the document + email pipelines run every 15 min via `pg_cron` + `pg_net`. Schedule (defined across migrations `20260420…`, `20260508220000…`, `20260515220000…`, `20260515230000…`, `20260516010000…`):
  - `:00/:15/:30/:45` — `classify-genie` (Drive root → subfolder routing)
  - `:02/:17/:32/:47` — `scan-genie` + `scan-deposits` (Drive subfolder handlers)
  - `:05/:20/:35/:50` — `scan-email`
  - `:07/:22/:37/:52` — `scan-ramp`
  - `:09/:24/:39/:54` — `post-ramp-payment`
  Cron uses publishable/anon key in apikey header. Change frequency by editing the migration and re-pushing — migrations are idempotent.

## Database tables (Supabase/Postgres)

- `bills` — vendor_id, invoice_number, dates, total_amount, drive_file_id, email_message_id, email_from, email_subject, source (genie/email), status (pending/reviewed/posted/error), qbo_bill_id, raw_extraction
- `bill_line_items` — bill_id, description, sku, qty, prices, qbo_account_id, mapping_id, mapping_confidence
- `vendors` — name, short_name, qbo_vendor_id, vendor_type, payment_notes (synced from QBO via sync-vendors)
- `qbo_accounts` — name, account_number, account_type. Current mappings: Food from Claude (1150040018), Packaging from Claude (1150040019), Kitchen Supplies (17)
- `qbo_tokens` — singleton row (id=1), stores refresh_token + realm_id for QBO OAuth
- `vendor_item_mappings` — vendor_id, item_description, item_sku, qbo_account_id, confidence (learning table for auto-mapping)
- `deposits` — drive_file_id (unique), drive_file_name, deposit_date, chase_total, stubs_total, reconciliation_status, status (pending/reviewed/posted/error), raw_extraction
- `deposit_stubs` — deposit_id, payer_name, payer_qbo_customer_id, check_number, check_date, amount, invoice_refs (JSONB), match_status (pending/matched/partial/unmatched/customer_unknown)
- `ramp_payments` — ramp_payment_id (unique), direction (ar/ap), event_type (initiated/delivered), payer_name, invoice_number, amount, payment_type (Check/ACH), payment_date, estimated_arrival, trace_id, qbo_receive_payment_id (unique), qbo_customer_id/name, qbo_invoice_id/balance, status (pending/posted/review/error/ignored), raw_email_body, raw_parse
- `bom_*` tables — three-tier BOM (recipes, ingredients, products)

## Gmail labels (billing@thegreencart.com)

- `bill` (Label_5800834809592445520) — vendor invoices
- `bill payment` (Label_417079469314741482) — outbound payment advices
- `invoice payment` (Label_5982998896632529955) — inbound customer payments (AR)

## Google Drive folders

- `genie/` (env var `GOOGLE_DRIVE_GENIE_FOLDER_ID`) — single intake folder. Scanner drops everything into root, classify-genie routes to subfolder.
  - `genie/bills/` — classifier routes vendor invoices here; scan-genie picks up
    - `genie/bills/processed/YYYY/` — successfully staged bills, suffix `(from scan)` or `(from email)`
    - `genie/bills/errors/` — extraction failures
  - `genie/check-stubs/` — classifier routes AR check stubs here; scan-deposits picks up
    - `genie/check-stubs/processed/YYYY/` — successfully staged deposits, suffix `(deposit)`
    - `genie/check-stubs/errors/` — extraction failures
  - `genie/haccp/` — classifier routes food-safety paperwork here (archival; no handler yet)
  - `genie/payment-advices/` — classifier routes vendor payment advices here (no handler yet)
  - `genie/other/` — classifier dropped here when uncertain (<0.6 confidence) or doc didn't fit a known category; needs human triage
- Paper receipts (`1pFDsBZ2ktag8bd-RNUwNfbCyoyHwhBaO`) — filed by year subfolder, for non-COGS receipts

## Commands

- `cd app && npm run dev` — start frontend dev server (port 5173)
- `supabase start` — start local Supabase (API 54321, DB 54322, Studio 54323)
- `supabase functions serve` — serve edge functions locally
- `supabase db push` — push migrations to remote
- `supabase functions deploy <name> --no-verify-jwt` — deploy edge function (always use --no-verify-jwt)
- `vercel --prod` — deploy frontend to production
- `python3 get_google_token.py` — re-auth Google OAuth (updates google_token.json)

## Conventions

- Auto-save inline edits immediately (no manual Save buttons)
- QBO OAuth goes through `_shared/qbo-client.ts` only — never make direct QBO API calls
- QBO re-auth: Intuit OAuth Playground → get refresh token → update `qbo_tokens` table
- All edge functions deployed with `--no-verify-jwt` (internal tool, auth handled by Supabase client)
- Deploy straight to production (no staging environment needed for this internal tool)
- Vercel deploy comes from the repo root (`vercel --prod`), not `app/` — the project is wired to build via root `vercel.json` (`cd app && npm install && npm run build`)
- This is a Vite SPA, not Next.js — ignore "use client" directive suggestions
- `.vercelignore` at repo root keeps `scripts/qbo-*` audit dumps (some GB-sized) from busting Vercel's 100MB upload cap. Only `app/` + `vercel.json` need to ship.

## Team

- **Jeff** (CEO/owner) — hands-on with non-COGS bank-feed matching, error/review triage, month-end close
- **Amerykah Medford** (Director of Ops) — scans paper bills + check stubs into `/genie/`
- **Lakshmi** (remote bookkeeper, the "Book Keeper" in QBO audit log) — customer mailed-check deposit posting, weekly ACH drafts, customer credit applications, adjusting AR invoices from driver-marked delivery slips
- **Justin** (admin) — new vendor/customer setup, daily driver-route-sheet review and driver payment entry

Canonical "who does what / what's automated" map: see memory `bookkeeper-handoff`.
