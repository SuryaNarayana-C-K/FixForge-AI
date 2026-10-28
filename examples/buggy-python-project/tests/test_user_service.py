from user_service import can_access_admin_panel, normalize_email


def test_normalize_email():
    assert normalize_email("  DEV@EXAMPLE.COM ") == "dev@example.com"


def test_admin_access_is_explicit():
    assert can_access_admin_panel("admin") is True
    assert can_access_admin_panel("user") is False