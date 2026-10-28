from invoice import calculate_invoice_total

def test_invoice_with_tax():
    # 100 with 10% tax should be 110.0
    assert calculate_invoice_total(100.0, 10.0) == 110.0
