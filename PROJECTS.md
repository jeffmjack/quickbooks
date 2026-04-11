# Green Cart — Active Finance Projects

_This file is the source of truth for ongoing projects. Update status and notes here._

---

## Project 1: Invoice Audit → Vendor Item Mapping Table
**Status:** In Progress  
**Goal:** Review how scanned invoices in Google Drive have been entered into QBO by the bookkeeper, and build a `vendor_item_mappings` table that maps vendor line item descriptions/SKUs → QBO accounts/items.

**What's built:**
- `audit_bills.py` — downloads PDFs from the "Entered Bills" Drive folder, uses Claude vision to extract invoice data, matches to QBO bills by invoice number or date/vendor, then populates `vendor_item_mappings` in Supabase.
- Drive folder ID for entered bills: `1l4eDyFh-FztzGdNGCDNAmOrWpXDHdHCK`
- Supabase tables: `vendors`, `qbo_accounts`, `vendor_item_mappings`, `bills`, `bill_line_items`

**Known issues / open questions:**
- Positional matching (PDF line j → QBO line j) is fragile — bookkeeper sometimes collapses multi-line invoices to fewer QBO lines
- Some bills have no QBO match (invoice number mismatch); these get skipped and logged as errors
- Confidence field is set from Claude extraction confidence, not from actual match quality

**Next steps:**
- [ ] Run `audit_bills.py` on full bill history and review mapping coverage
- [ ] Manually review low-confidence or unmatched mappings
- [ ] Decide: keep item-based vs account-based posting convention going forward

---

## Project 2: Automated Bill Entry (Claude → QBO)
**Status:** Planned — depends on Project 1  
**Goal:** Have Claude process new invoices from Drive, apply the `vendor_item_mappings`, and post bills directly to QBO — replacing or checking the bookkeeper's manual entry.

**What's needed:**
- `vendor_item_mappings` table sufficiently populated (Project 1)
- A `post_bill.py` or similar script using QBO Bill Create API
- A review/approval step before posting (at least initially)
- Handling for new vendors or unmapped items (human fallback)

**Open questions:**
- Do we want a "draft + review" mode or auto-post for high-confidence mappings?
- How do we handle new items that don't exist in the mapping table yet?

---

## Project 3: Independent Ingredient Cost Database
**Status:** Planned — runs parallel to Project 2  
**Goal:** As bills are processed, populate `bom_ingredients` and `bom_ingredient_costs` to maintain a rolling cost history per ingredient — independent of QBO.

**What's needed:**
- Mapping from vendor line items → ingredients (extends `vendor_item_mappings`)
- `bom_ingredients` table to be populated (currently empty)
- Normalization logic: same ingredient may come from multiple vendors or under different descriptions

**Key tables:**
- `bom_ingredients` — master ingredient list with unit of measure
- `bom_ingredient_costs` — unit cost per ingredient per bill, linked to `bill_line_items`

---

## Project 4: Recipe Costing (Per-Item Food COGS)
**Status:** Future — depends on Projects 2 & 3  
**Goal:** Build out recipes in `bom_menu_items` + `bom_recipe_lines`, then calculate actual per-item food COGS from rolling ingredient costs.

**What's needed:**
- Recipes don't exist yet — need to be entered
- Ingredient cost history (Project 3)
- Report: for each menu item, cost = Σ(ingredient qty × latest/avg unit cost)

---

## Ghost Kitchen Account Inactivation
**Status:** Pending  
**Goal:** Ghost kitchen operations (revenue and expenses) haven't run for years. Any 2025 activity in ghost kitchen accounts needs to be reclassified to the correct accounts, and all ghost kitchen accounts should be inactivated in QBO so they can't be accidentally used going forward.

**Accounts to inactivate (once cleaned):**
- 4400 Ghost Kitchens Revenue (ID 49)
- 5400 Ghost Kitchens COGS (ID 68)
- 5420 Ghost Kitchen Packaging (ID 70)
- Ghost Kitchen Food Cost (ID 69)

**Next steps:**
- [ ] Pull GL for all ghost kitchen accounts for full history (at least 2024–2025) to find any stray activity
- [ ] Reclassify any activity to correct accounts (per-transaction JE or omnibus)
- [ ] Inactivate all ghost kitchen accounts in QBO via API

---

## CPA Issue: Delivery Fee Revenue / Driver Cost Reclassification
**Status:** In Progress — awaiting Homebase 1099-NEC report for 2025  
**Issue flagged by CPA:** Delivery fees collected from customers were being zeroed out monthly and netted as a contra against driver costs, rather than recognized as income. This understates both revenue and gross driver payments, creating 1099/W-2 reporting problems.

**2025 year-end AJE needed:**
```
Dr. Delivery Contract Labor 1099    $X    (gross up to actual payments made)
    Cr. Delivery Fee Revenue        $X    (recognize as income)
```
Amount = (gross 2025 contractor payments per Homebase) minus ($95,307.80 currently in QBO)  
**Waiting on:** Homebase 1099-NEC report for 2025 → Jeffrey dropping in `/private-docs/`

**2026 going forward:**
- Delivery fee revenue must be posted as income, never netted
- Driver cost accounts need to split: W-2 wages (payroll) vs. 1099 contractor payments
- `Delivery Contract Labor 1099` account should only capture true 1099 payments
- **Legal context:** Lawyer advised transitioning drivers from 1099 → W-2. Transition in progress as of early 2026. Some newer hires still on 1099 during transition. Watch for people who received both 1099 and W-2 payments in 2026 — cutover dates need to be documented cleanly.

---

## Data & Tooling Reference
| Thing | Value / Location |
|---|---|
| QBO connection | OAuth via `.env` (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, REALM_ID) |
| Google Drive auth | `google_token.json` + `get_google_token.py` |
| Supabase | `.env` SUPABASE_PROJECT_URL + SUPABASE_SERVICE_ROLE_KEY |
| Entered Bills folder | Drive ID `1l4eDyFh-FztzGdNGCDNAmOrWpXDHdHCK` |
| Financial reports | `private-docs/` (through Feb 2026) |
| DB schema | `supabase/migrations/20260405000000_initial_schema.sql` |
