-- ============================================================
-- Enable RLS on all tables (deny-by-default)
-- Service role key bypasses RLS, so scripts are unaffected.
-- This blocks all anon key access via the REST API.
-- ============================================================

ALTER TABLE vendors                ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_item_mappings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_line_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_ingredients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_ingredient_costs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_menu_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_recipe_lines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_financials     ENABLE ROW LEVEL SECURITY;
