from pricing import calculate_discount

def test_vip_single_item():
    # VIP should receive 20% discount on single item: 100 * 0.80 = 80.0
    result = calculate_discount(100.0, 1, "vip")
    assert result == 80.0, f"Expected 80.0 for VIP discount, got {result}"

def test_silver_order():
    result = calculate_discount(100.0, 1, "silver")
    assert result == 90.0
