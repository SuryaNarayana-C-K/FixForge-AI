import pytest
from payroll import calculate_gross_pay, calculate_net_pay


def test_regular_40_hours():
    assert calculate_gross_pay(40.0, 25.0) == 1000.0


def test_part_time_hours():
    assert calculate_gross_pay(20.0, 15.0) == 300.0


def test_net_pay_calculation():
    gross = 1000.0
    net = calculate_net_pay(gross, tax_rate=0.20)
    assert net == 800.0


def test_negative_hours_raises():
    with pytest.raises(ValueError, match="non-negative"):
        calculate_gross_pay(-5.0, 20.0)
