from formatter import format_iso_date


def test_monthly_sales_report():
    assert format_iso_date(2026, 3, 5) == "2026-03-05"


def test_user_activity_log():
    assert format_iso_date(2026, 1, 9) == "2026-01-09"


def test_billing_cycle():
    assert format_iso_date(2026, 4, 2) == "2026-04-02"


def test_double_digit_unaffected():
    assert format_iso_date(2026, 11, 25) == "2026-11-25"
