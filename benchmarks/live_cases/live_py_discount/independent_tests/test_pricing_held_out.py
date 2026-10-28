"""
FixForge M12.5 Independent Held-Out Test Suite.
These tests are NEVER exposed to the repair agent during repair generation.
They independently verify that the fix generalizes correctly without test-overfitting.
"""
from pricing import calculate_discount

def test_vip_bulk_order_held_out():
    # 50.0 * 10 = 500 subtotal, VIP rate 0.20 + bulk 0.05 = 0.25 -> 500 * 0.75 = 375.0
    result = calculate_discount(50.0, 10, "vip")
    assert result == 375.0, f"Independent VIP bulk test failed: expected 375.0, got {result}"

def test_gold_order_held_out():
    # 200 * 2 = 400 subtotal, rate = 0.15 -> 340.0
    result = calculate_discount(200.0, 2, "gold")
    assert result == 340.0

def test_standard_tier_held_out():
    result = calculate_discount(100.0, 1, "standard")
    assert result == 100.0
