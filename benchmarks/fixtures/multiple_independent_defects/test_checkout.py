from discounts import apply_tier_discount
from tax import calculate_sales_tax


def test_vip_discount():
    assert apply_tier_discount(100.0, "VIP") == 80.0


def test_california_tax():
    assert calculate_sales_tax(100.0, "CA") == 7.25
