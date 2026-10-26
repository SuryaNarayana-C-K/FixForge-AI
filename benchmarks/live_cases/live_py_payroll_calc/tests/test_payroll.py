import pytest
from payroll import calculate_gross_pay


def test_overtime_pay_rate():
    # 50 hours at $20/hr: 40 hrs regular ($800) + 10 hrs overtime at 1.5x ($300) = $1100.0
    gross = calculate_gross_pay(50.0, 20.0)
    assert gross == 1100.0
