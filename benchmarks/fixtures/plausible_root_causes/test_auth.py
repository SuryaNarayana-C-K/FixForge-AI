from auth_service import login_user, register_user
from auth_utils import normalize_username


def test_standard_user():
    res = login_user("Alice")
    assert res["user"] == "alice"


def test_empty_username_handled():
    # Empty string should normalize to empty string rather than crash
    res = login_user("")
    assert res["user"] == ""
