-- ============================================================
-- RLS policies: allow authenticated users full access
-- Service role already bypasses RLS (scripts unaffected).
-- Anon key remains blocked (no anon policies).
-- ============================================================

-- Helper: creates SELECT/INSERT/UPDATE/DELETE policies for authenticated role
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'vendors',
        'qbo_accounts',
        'vendor_item_mappings',
        'bills',
        'bill_line_items',
        'bom_items',
        'bom_recipe_lines',
        'bom_ingredient_costs',
        'bom_item_vendor_links',
        'monthly_financials'
    ]
    LOOP
        EXECUTE format(
            'CREATE POLICY "authenticated_select" ON %I FOR SELECT TO authenticated USING (true)',
            t
        );
        EXECUTE format(
            'CREATE POLICY "authenticated_insert" ON %I FOR INSERT TO authenticated WITH CHECK (true)',
            t
        );
        EXECUTE format(
            'CREATE POLICY "authenticated_update" ON %I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)',
            t
        );
        EXECUTE format(
            'CREATE POLICY "authenticated_delete" ON %I FOR DELETE TO authenticated USING (true)',
            t
        );
    END LOOP;
END $$;
