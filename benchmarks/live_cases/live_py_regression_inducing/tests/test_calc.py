from calc import calculate_charge

def test_charge_with_fee():
    # Target test: expects base + fee = 15. In baseline, returns 10, so this fails.
    assert calculate_charge(10, 5) == 15

def test_base_preserved():
    # Baseline assertion that passes initially: calculate_charge(20, 0) == 20
    # But if patch changes return to 'fee', this becomes 0 and regresses!
    assert calculate_charge(20, 0) == 20
