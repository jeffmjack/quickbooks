-- ============================================================
-- Green Cart Finance DB - Initial Schema
-- ============================================================

-- Vendors (synced from QBO + enriched)
CREATE TABLE vendors (
    id                  SERIAL PRIMARY KEY,
    qbo_vendor_id       TEXT UNIQUE,
    name                TEXT NOT NULL,
    short_name          TEXT,               -- e.g. "US Foods", "Ben E. Keith"
    vendor_type         TEXT,               -- 'food', 'consumables', 'services', etc.
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- QBO accounts we post bills to
CREATE TABLE qbo_accounts (
    id                  SERIAL PRIMARY KEY,
    qbo_account_id      TEXT UNIQUE,
    name                TEXT NOT NULL,
    account_number      TEXT,
    account_type        TEXT,               -- 'COGS', 'Expense', etc.
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Mapping: vendor line item description → QBO account
-- Built from auditing entered bills; used by bill processor
CREATE TABLE vendor_item_mappings (
    id                  SERIAL PRIMARY KEY,
    vendor_id           INTEGER REFERENCES vendors(id),
    item_description    TEXT NOT NULL,      -- as it appears on the invoice
    item_sku            TEXT,               -- vendor SKU/product code if available
    qbo_account_id      INTEGER REFERENCES qbo_accounts(id),
    qbo_item_id         TEXT,               -- if posted to an item vs account
    confidence          NUMERIC DEFAULT 1.0, -- 1.0 = confirmed, <1.0 = inferred
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Bills processed from Drive/Gmail
CREATE TABLE bills (
    id                  SERIAL PRIMARY KEY,
    vendor_id           INTEGER REFERENCES vendors(id),
    invoice_number      TEXT,
    invoice_date        DATE,
    due_date            DATE,
    total_amount        NUMERIC(12,2),
    qbo_bill_id         TEXT UNIQUE,        -- set after posting to QBO
    drive_file_id       TEXT,               -- Google Drive file ID
    drive_file_name     TEXT,
    source              TEXT DEFAULT 'drive', -- 'drive' or 'gmail'
    status              TEXT DEFAULT 'pending', -- 'pending','reviewed','posted','error'
    error_message       TEXT,
    raw_extraction      JSONB,              -- full Claude extraction output
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Individual line items from bills
CREATE TABLE bill_line_items (
    id                  SERIAL PRIMARY KEY,
    bill_id             INTEGER REFERENCES bills(id) ON DELETE CASCADE,
    line_number         INTEGER,
    description         TEXT,
    sku                 TEXT,
    quantity            NUMERIC(12,4),
    unit                TEXT,
    unit_price          NUMERIC(12,4),
    extended_price      NUMERIC(12,2),
    qbo_account_id      INTEGER REFERENCES qbo_accounts(id),
    mapping_id          INTEGER REFERENCES vendor_item_mappings(id),
    mapping_confidence  NUMERIC DEFAULT 1.0,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- BOM: ingredients/components
CREATE TABLE bom_ingredients (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT,
    unit                TEXT NOT NULL,      -- 'lb', 'oz', 'each', 'case', etc.
    vendor_id           INTEGER REFERENCES vendors(id),
    vendor_sku          TEXT,
    category            TEXT,               -- 'protein', 'produce', 'packaging', etc.
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- BOM: cost history per ingredient (populated from bill line items)
CREATE TABLE bom_ingredient_costs (
    id                  SERIAL PRIMARY KEY,
    ingredient_id       INTEGER REFERENCES bom_ingredients(id),
    bill_line_item_id   INTEGER REFERENCES bill_line_items(id),
    date                DATE NOT NULL,
    unit_cost           NUMERIC(12,4) NOT NULL,
    quantity_purchased  NUMERIC(12,4),
    vendor_id           INTEGER REFERENCES vendors(id),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- BOM: menu items/recipes
CREATE TABLE bom_menu_items (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,      -- 'Breakfast Taco', 'Sandwich', etc.
    category            TEXT,               -- 'wholesale', 'catering', etc.
    selling_price       NUMERIC(12,2),
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- BOM: recipe lines (what goes into each menu item)
CREATE TABLE bom_recipe_lines (
    id                  SERIAL PRIMARY KEY,
    menu_item_id        INTEGER REFERENCES bom_menu_items(id) ON DELETE CASCADE,
    ingredient_id       INTEGER REFERENCES bom_ingredients(id),
    quantity            NUMERIC(12,4) NOT NULL,
    unit                TEXT NOT NULL,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Monthly financial snapshots (for R12 / Thinking Model)
CREATE TABLE monthly_financials (
    id                  SERIAL PRIMARY KEY,
    period              DATE NOT NULL,      -- first day of month
    revenue             NUMERIC(14,2),
    cogs                NUMERIC(14,2),
    gross_margin        NUMERIC(14,2),
    direct_labor        NUMERIC(14,2),
    contribution_margin NUMERIC(14,2),
    facilities          NUMERIC(14,2),
    marketing           NUMERIC(14,2),
    management_labor    NUMERIC(14,2),
    payroll_taxes       NUMERIC(14,2),
    other_opex          NUMERIC(14,2),
    total_opex          NUMERIC(14,2),
    noi                 NUMERIC(14,2),
    net_income          NUMERIC(14,2),
    -- derived ratios
    gm_pct              NUMERIC(8,4),
    direct_ler          NUMERIC(8,4),
    mgmt_ler            NUMERIC(8,4),
    cm_pct              NUMERIC(8,4),
    noi_pct             NUMERIC(8,4),
    opex_pct            NUMERIC(8,4),
    -- metadata
    source              TEXT DEFAULT 'qbo', -- 'qbo' or 'manual'
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(period)
);

-- Indexes
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_vendor ON bills(vendor_id);
CREATE INDEX idx_bill_items_bill ON bill_line_items(bill_id);
CREATE INDEX idx_bom_costs_ingredient ON bom_ingredient_costs(ingredient_id);
CREATE INDEX idx_bom_costs_date ON bom_ingredient_costs(date);
CREATE INDEX idx_monthly_period ON monthly_financials(period);
CREATE INDEX idx_mappings_vendor ON vendor_item_mappings(vendor_id);
