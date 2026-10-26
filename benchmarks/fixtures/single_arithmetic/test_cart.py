from cart import calculate_total

def test_calculate_total_regular():
    assert calculate_total(100.0, 10.0) == 90.0

def test_calculate_total_zero_discount():
    assert calculate_total(50.0, 0.0) == 50.0
