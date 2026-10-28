import pytest
from pricing import calculate_discount

def test_invalid_negative_price():
    with pytest.raises(ValueError, match="Invalid price"):
        calculate_discount(-10.0, 1)

def test_bulk_silver_order():
    # 100 * 10 = 1000 subtotal, rate = 0.10 + 0.05 = 0.15 -> 850.0
    result = calculate_discount(100.0, 10, "silver")
    assert result == 850.0
