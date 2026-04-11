-- ============================================================
-- Three-Tier BOM Cost Model
-- Replaces flat bom_ingredients/bom_menu_items with a unified
-- bom_items table supporting: base_ingredient → composed → product
-- ============================================================

-- Safety: verify old tables are empty before dropping
DO $$
BEGIN
    IF (SELECT COUNT(*) FROM bom_recipe_lines) > 0 THEN
        RAISE EXCEPTION 'bom_recipe_lines is not empty — aborting migration';
    END IF;
    IF (SELECT COUNT(*) FROM bom_ingredient_costs) > 0 THEN
        RAISE EXCEPTION 'bom_ingredient_costs is not empty — aborting migration';
    END IF;
    IF (SELECT COUNT(*) FROM bom_menu_items) > 0 THEN
        RAISE EXCEPTION 'bom_menu_items is not empty — aborting migration';
    END IF;
    IF (SELECT COUNT(*) FROM bom_ingredients) > 0 THEN
        RAISE EXCEPTION 'bom_ingredients is not empty — aborting migration';
    END IF;
END $$;

-- Drop old BOM tables
DROP TABLE IF EXISTS bom_recipe_lines CASCADE;
DROP TABLE IF EXISTS bom_ingredient_costs CASCADE;
DROP TABLE IF EXISTS bom_menu_items CASCADE;
DROP TABLE IF EXISTS bom_ingredients CASCADE;

-- ============================================================
-- bom_items: unified table for all three tiers
-- ============================================================
CREATE TABLE bom_items (
    id                      SERIAL PRIMARY KEY,
    item_type               TEXT NOT NULL CHECK (item_type IN ('base_ingredient', 'composed', 'product')),
    name                    TEXT NOT NULL,
    category                TEXT,
    costing_unit            TEXT NOT NULL DEFAULT 'gram' CHECK (costing_unit IN ('gram', 'each')),
    is_active               BOOLEAN DEFAULT TRUE,

    -- Base ingredient: purchase info
    purchase_unit_desc      TEXT,           -- e.g. "1 pound bag", "case of 6 #10 cans"
    purchase_unit_grams     NUMERIC(12,4), -- grams per purchase unit (gram-based items)
    purchase_unit_each      NUMERIC(12,4), -- count per purchase unit (each-based items)
    yield_pct               NUMERIC(5,4) DEFAULT 1.0,  -- 0.85 = 85% usable after trim
    vendor_id               INTEGER REFERENCES vendors(id),
    vendor_sku              TEXT,

    -- Composed/product: recipe yield
    recipe_yield_qty        NUMERIC(12,4), -- how much the recipe makes
    recipe_yield_unit       TEXT,           -- 'gram' or 'each'

    -- Product: pricing
    selling_price           NUMERIC(12,2),
    target_food_cost_pct    NUMERIC(5,4),  -- e.g. 0.30 for 30%

    notes                   TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE bom_items IS 'Unified BOM: base_ingredient (purchased), composed (prepped), product (sold)';
COMMENT ON COLUMN bom_items.costing_unit IS 'gram = cost per gram, each = cost per piece (bread, tortilla, packaging)';
COMMENT ON COLUMN bom_items.yield_pct IS 'Usable portion after waste/trim. 1.0 = no waste. Only for base_ingredient.';

-- ============================================================
-- bom_recipe_lines: what goes into a composed item or product
-- ============================================================
CREATE TABLE bom_recipe_lines (
    id                      SERIAL PRIMARY KEY,
    parent_item_id          INTEGER NOT NULL REFERENCES bom_items(id) ON DELETE CASCADE,
    component_item_id       INTEGER NOT NULL REFERENCES bom_items(id),
    quantity                NUMERIC(12,4) NOT NULL,  -- in the component's costing_unit
    sort_order              INTEGER DEFAULT 0,
    notes                   TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT no_self_reference CHECK (parent_item_id != component_item_id)
);

COMMENT ON TABLE bom_recipe_lines IS 'Recipe components. quantity is in the component costing_unit (grams or each).';

-- ============================================================
-- bom_ingredient_costs: historical purchase costs (from bills)
-- ============================================================
CREATE TABLE bom_ingredient_costs (
    id                      SERIAL PRIMARY KEY,
    item_id                 INTEGER NOT NULL REFERENCES bom_items(id),
    bill_line_item_id       INTEGER REFERENCES bill_line_items(id),
    effective_date          DATE NOT NULL,
    purchase_unit_cost      NUMERIC(12,4) NOT NULL,  -- cost of one purchase unit
    quantity_purchased      NUMERIC(12,4),            -- how many purchase units bought
    cost_per_unit           NUMERIC(12,6),            -- derived: per gram or per each
    vendor_id               INTEGER REFERENCES vendors(id),
    source                  TEXT NOT NULL DEFAULT 'bill' CHECK (source IN ('bill', 'manual', 'spreadsheet_import')),
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN bom_ingredient_costs.cost_per_unit IS 'For gram items: cost / (purchase_unit_grams * yield_pct). For each items: cost / purchase_unit_each.';

-- ============================================================
-- bom_item_vendor_links: multi-vendor support
-- ============================================================
CREATE TABLE bom_item_vendor_links (
    id                      SERIAL PRIMARY KEY,
    item_id                 INTEGER NOT NULL REFERENCES bom_items(id) ON DELETE CASCADE,
    vendor_id               INTEGER NOT NULL REFERENCES vendors(id),
    vendor_sku              TEXT,
    vendor_description      TEXT,   -- how it appears on their invoices
    is_primary              BOOLEAN DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (item_id, vendor_id)
);

-- ============================================================
-- Link vendor_item_mappings → bom_items
-- ============================================================
ALTER TABLE vendor_item_mappings
    ADD COLUMN bom_item_id INTEGER REFERENCES bom_items(id);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_bom_items_type ON bom_items(item_type);
CREATE INDEX idx_bom_items_category ON bom_items(category);
CREATE INDEX idx_bom_items_active ON bom_items(is_active);
CREATE INDEX idx_bom_recipe_parent ON bom_recipe_lines(parent_item_id);
CREATE INDEX idx_bom_recipe_component ON bom_recipe_lines(component_item_id);
CREATE INDEX idx_bom_costs_item_date ON bom_ingredient_costs(item_id, effective_date DESC);
CREATE INDEX idx_bom_vendor_links_item ON bom_item_vendor_links(item_id);
CREATE INDEX idx_bom_vendor_links_vendor ON bom_item_vendor_links(vendor_id);

-- ============================================================
-- View: latest cost per base ingredient
-- ============================================================
CREATE VIEW bom_current_costs AS
SELECT DISTINCT ON (item_id)
    item_id,
    effective_date,
    purchase_unit_cost,
    cost_per_unit,
    vendor_id,
    source
FROM bom_ingredient_costs
ORDER BY item_id, effective_date DESC, created_at DESC;

-- ============================================================
-- Function: cost per unit for any BOM item
-- For base ingredients: returns cost_per_unit from latest cost record
-- For composed/products: recursively sums component costs, then
--   divides by recipe_yield_qty to get per-unit cost
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_item_cost(p_item_id INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_item RECORD;
    v_batch_cost NUMERIC := 0;
    v_line RECORD;
    v_component_unit_cost NUMERIC;
BEGIN
    SELECT item_type, costing_unit, recipe_yield_qty
    INTO v_item
    FROM bom_items WHERE id = p_item_id;

    -- Base ingredient: return latest cost_per_unit directly
    IF v_item.item_type = 'base_ingredient' THEN
        RETURN COALESCE(
            (SELECT cost_per_unit FROM bom_current_costs WHERE item_id = p_item_id),
            0
        );
    END IF;

    -- Composed or product: sum up component costs
    FOR v_line IN
        SELECT component_item_id, quantity
        FROM bom_recipe_lines
        WHERE parent_item_id = p_item_id
        ORDER BY sort_order
    LOOP
        v_component_unit_cost := calculate_item_cost(v_line.component_item_id);
        v_batch_cost := v_batch_cost + (v_line.quantity * v_component_unit_cost);
    END LOOP;

    -- If recipe_yield_qty is set, return per-unit cost; otherwise return batch cost
    IF v_item.recipe_yield_qty IS NOT NULL AND v_item.recipe_yield_qty > 0 THEN
        RETURN v_batch_cost / v_item.recipe_yield_qty;
    END IF;

    RETURN v_batch_cost;
END;
$$;

COMMENT ON FUNCTION calculate_item_cost IS 'Returns cost per costing_unit for any BOM item. Base ingredients use latest purchase cost. Composed/products recursively roll up component costs and divide by recipe yield.';

-- ============================================================
-- View: product margin analysis
-- ============================================================
CREATE VIEW bom_product_margins AS
SELECT
    bi.id,
    bi.name,
    bi.category,
    bi.selling_price,
    bi.target_food_cost_pct,
    calculate_item_cost(bi.id) AS computed_cost,
    CASE WHEN bi.selling_price > 0
        THEN ROUND(calculate_item_cost(bi.id) / bi.selling_price, 4)
        ELSE NULL
    END AS actual_food_cost_pct,
    bi.is_active
FROM bom_items bi
WHERE bi.item_type = 'product';

-- ============================================================
-- RLS: deny-by-default (service role bypasses)
-- ============================================================
ALTER TABLE bom_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_recipe_lines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_ingredient_costs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_item_vendor_links  ENABLE ROW LEVEL SECURITY;
