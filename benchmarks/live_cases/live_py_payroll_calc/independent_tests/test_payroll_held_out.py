import pytest
from payroll import calculate_gross_pay, calculate_net_pay


def test_fractional_overtime_held_out():
    # 44.5 hours at $30/hr: 40 hrs regular (1200) + 4.5 hrs at $45/hr (202.50) = 1402.50
    gross = calculate_gross_pay(44.5, 30.0)
    assert gross == 1402.50
    net = calculate_net_pay(gross, tax_rate=0.10)
    assert net == 1262.25
