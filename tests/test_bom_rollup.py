"""
Tests for BOM three-tier cost rollup.

Inserts known test data into a clean set of bom_ tables,
verifies calculate_item_cost() and bom_product_margins,
then cleans up after itself.

Requires SUPABASE_PROJECT_URL and SUPABASE_SERVICE_ROLE_KEY in env or .env.
"""

import os
import pytest
from supabase import create_client


@pytest.fixture(scope="module")
def sb():
    url = os.environ.get("SUPABASE_PROJECT_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        from dotenv import load_dotenv
        load_dotenv()
        url = os.environ["SUPABASE_PROJECT_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


@pytest.fixture(scope="module")
def test_items(sb):
    """Insert a minimal three-tier recipe and yield all IDs for tests."""
    ids = {}

    # --- Base ingredients ---
    flour = sb.table("bom_items").insert({
        "item_type": "base_ingredient", "name": "_test flour",
        "category": "grains", "costing_unit": "gram",
        "purchase_unit_desc": "50lb bag", "purchase_unit_grams": 22700,
        "yield_pct": 1.0,
    }).execute().data[0]
    ids["flour"] = flour["id"]

    sugar = sb.table("bom_items").insert({
        "item_type": "base_ingredient", "name": "_test sugar",
        "category": "herbs_spices", "costing_unit": "gram",
        "purchase_unit_desc": "1lb bag", "purchase_unit_grams": 454,
        "yield_pct": 1.0,
    }).execute().data[0]
    ids["sugar"] = sugar["id"]

    egg = sb.table("bom_items").insert({
        "item_type": "base_ingredient", "name": "_test egg",
        "category": "proteins", "costing_unit": "each",
        "purchase_unit_desc": "dozen", "purchase_unit_each": 12,
        "yield_pct": 1.0,
    }).execute().data[0]
    ids["egg"] = egg["id"]

    box = sb.table("bom_items").insert({
        "item_type": "base_ingredient", "name": "_test box",
        "category": "packaging", "costing_unit": "each",
        "purchase_unit_desc": "case of 100", "purchase_unit_each": 100,
        "yield_pct": 1.0,
    }).execute().data[0]
    ids["box"] = box["id"]

    trimmed = sb.table("bom_items").insert({
        "item_type": "base_ingredient", "name": "_test trimmed herb",
        "category": "herbs_spices", "costing_unit": "gram",
        "purchase_unit_desc": "1lb bag", "purchase_unit_grams": 454,
        "yield_pct": 0.5,
    }).execute().data[0]
    ids["trimmed"] = trimmed["id"]

    # --- Costs ---
    # flour: $20/bag → $20/22700g = $0.000881/g
    # sugar: $1/bag → $1/454g = $0.002203/g
    # egg: $3.60/dozen → $0.30/each
    # box: $50/case → $0.50/each
    # trimmed herb: $10/lb, 50% yield → $10/(454*0.5) = $0.044053/g
    costs = [
        (ids["flour"], 20.00, "2024-01-01"),
        (ids["sugar"], 1.00, "2024-01-01"),
        (ids["egg"], 3.60, "2024-01-01"),
        (ids["box"], 50.00, "2024-01-01"),
        (ids["trimmed"], 10.00, "2024-01-01"),
    ]
    cost_ids = []
    for item_id, cost, date in costs:
        item = sb.table("bom_items").select(
            "purchase_unit_grams, purchase_unit_each, yield_pct, costing_unit"
        ).eq("id", item_id).execute().data[0]
        if item["costing_unit"] == "gram":
            cpu = cost / (item["purchase_unit_grams"] * item["yield_pct"])
        else:
            cpu = cost / (item["purchase_unit_each"] * item["yield_pct"])
        r = sb.table("bom_ingredient_costs").insert({
            "item_id": item_id, "effective_date": date,
            "purchase_unit_cost": cost, "cost_per_unit": round(cpu, 8),
            "source": "manual",
        }).execute()
        cost_ids.append(r.data[0]["id"])
    ids["_cost_ids"] = cost_ids

    # --- Composed: "dough" (flour + sugar + egg), yields 1000g ---
    dough = sb.table("bom_items").insert({
        "item_type": "composed", "name": "_test dough",
        "category": "sauce", "costing_unit": "gram",
        "recipe_yield_qty": 1000, "recipe_yield_unit": "gram",
    }).execute().data[0]
    ids["dough"] = dough["id"]

    dough_lines = [
        (ids["dough"], ids["flour"], 500),   # 500g flour
        (ids["dough"], ids["sugar"], 100),    # 100g sugar
        (ids["dough"], ids["egg"], 3),        # 3 eggs (each-based)
    ]
    line_ids = []
    for parent, comp, qty in dough_lines:
        r = sb.table("bom_recipe_lines").insert({
            "parent_item_id": parent, "component_item_id": comp, "quantity": qty,
        }).execute()
        line_ids.append(r.data[0]["id"])

    # --- Composed: "herb dough" (dough + trimmed herb), yields 1100g ---
    # Tests composed-within-composed
    herb_dough = sb.table("bom_items").insert({
        "item_type": "composed", "name": "_test herb dough",
        "category": "sauce", "costing_unit": "gram",
        "recipe_yield_qty": 1100, "recipe_yield_unit": "gram",
    }).execute().data[0]
    ids["herb_dough"] = herb_dough["id"]

    for parent, comp, qty in [
        (ids["herb_dough"], ids["dough"], 1000),     # 1000g of dough
        (ids["herb_dough"], ids["trimmed"], 100),     # 100g trimmed herb
    ]:
        r = sb.table("bom_recipe_lines").insert({
            "parent_item_id": parent, "component_item_id": comp, "quantity": qty,
        }).execute()
        line_ids.append(r.data[0]["id"])

    # --- Product: "pastry" (herb dough + box), sells for $5 ---
    pastry = sb.table("bom_items").insert({
        "item_type": "product", "name": "_test pastry",
        "category": "breakfast", "costing_unit": "each",
        "selling_price": 5.00, "target_food_cost_pct": 0.30,
    }).execute().data[0]
    ids["pastry"] = pastry["id"]

    for parent, comp, qty in [
        (ids["pastry"], ids["herb_dough"], 200),  # 200g herb dough
        (ids["pastry"], ids["box"], 1),            # 1 box
    ]:
        r = sb.table("bom_recipe_lines").insert({
            "parent_item_id": parent, "component_item_id": comp, "quantity": qty,
        }).execute()
        line_ids.append(r.data[0]["id"])

    ids["_line_ids"] = line_ids

    yield ids

    # --- Cleanup ---
    for lid in line_ids:
        sb.table("bom_recipe_lines").delete().eq("id", lid).execute()
    for cid in cost_ids:
        sb.table("bom_ingredient_costs").delete().eq("id", cid).execute()
    for key in ["pastry", "herb_dough", "dough", "trimmed", "box", "egg", "sugar", "flour"]:
        sb.table("bom_items").delete().eq("id", ids[key]).execute()


def _cost(sb, item_id):
    return float(sb.rpc("calculate_item_cost", {"p_item_id": item_id}).execute().data)


class TestBaseIngredientCosts:
    def test_gram_based_cost(self, sb, test_items):
        # flour: $20 / 22700g = $0.000881
        cost = _cost(sb, test_items["flour"])
        assert abs(cost - 20.0 / 22700) < 1e-6

    def test_each_based_cost(self, sb, test_items):
        # egg: $3.60 / 12 = $0.30 each
        cost = _cost(sb, test_items["egg"])
        assert abs(cost - 0.30) < 1e-6

    def test_yield_affects_cost(self, sb, test_items):
        # trimmed herb: $10 / (454 * 0.5) = $0.044053/g
        cost = _cost(sb, test_items["trimmed"])
        expected = 10.0 / (454 * 0.5)
        assert abs(cost - expected) < 1e-5


class TestComposedItemCosts:
    def test_dough_batch_cost(self, sb, test_items):
        # dough per gram = (500*flour_cpg + 100*sugar_cpg + 3*egg_each) / 1000
        flour_cpg = 20.0 / 22700
        sugar_cpg = 1.0 / 454
        egg_each = 3.60 / 12
        batch = 500 * flour_cpg + 100 * sugar_cpg + 3 * egg_each
        expected_per_g = batch / 1000

        cost = _cost(sb, test_items["dough"])
        assert abs(cost - expected_per_g) < 1e-6

    def test_nested_composed(self, sb, test_items):
        # herb dough = (1000g dough * dough_cpg + 100g trimmed * trimmed_cpg) / 1100
        flour_cpg = 20.0 / 22700
        sugar_cpg = 1.0 / 454
        egg_each = 3.60 / 12
        dough_batch = 500 * flour_cpg + 100 * sugar_cpg + 3 * egg_each
        dough_cpg = dough_batch / 1000

        trimmed_cpg = 10.0 / (454 * 0.5)
        herb_batch = 1000 * dough_cpg + 100 * trimmed_cpg
        expected = herb_batch / 1100

        cost = _cost(sb, test_items["herb_dough"])
        assert abs(cost - expected) < 1e-6


class TestProductCosts:
    def test_product_total_cost(self, sb, test_items):
        # pastry = 200g herb_dough * herb_dough_cpg + 1 box * $0.50
        flour_cpg = 20.0 / 22700
        sugar_cpg = 1.0 / 454
        egg_each = 3.60 / 12
        dough_batch = 500 * flour_cpg + 100 * sugar_cpg + 3 * egg_each
        dough_cpg = dough_batch / 1000
        trimmed_cpg = 10.0 / (454 * 0.5)
        herb_batch = 1000 * dough_cpg + 100 * trimmed_cpg
        herb_cpg = herb_batch / 1100
        box_each = 50.0 / 100

        expected = 200 * herb_cpg + 1 * box_each
        cost = _cost(sb, test_items["pastry"])
        assert abs(cost - expected) < 1e-5

    def test_margins_view(self, sb, test_items):
        margins = sb.table("bom_product_margins").select("*").eq(
            "id", test_items["pastry"]
        ).execute().data
        assert len(margins) == 1
        m = margins[0]
        assert float(m["selling_price"]) == 5.00
        assert float(m["computed_cost"]) > 0
        assert float(m["actual_food_cost_pct"]) > 0


class TestEdgeCases:
    def test_missing_cost_returns_zero(self, sb):
        # Item with no cost record
        item = sb.table("bom_items").insert({
            "item_type": "base_ingredient", "name": "_test no cost",
            "category": "other", "costing_unit": "gram",
            "purchase_unit_grams": 100, "yield_pct": 1.0,
        }).execute().data[0]
        try:
            cost = _cost(sb, item["id"])
            assert cost == 0
        finally:
            sb.table("bom_items").delete().eq("id", item["id"]).execute()

    def test_empty_recipe_returns_zero(self, sb):
        item = sb.table("bom_items").insert({
            "item_type": "composed", "name": "_test empty recipe",
            "category": "other", "costing_unit": "gram",
            "recipe_yield_qty": 100,
        }).execute().data[0]
        try:
            cost = _cost(sb, item["id"])
            assert cost == 0
        finally:
            sb.table("bom_items").delete().eq("id", item["id"]).execute()
