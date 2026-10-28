import pytest
from user_service import parse_user_profile

def test_profile_with_middle_name():
    data = {
        "id": "usr-102",
        "first_name": "Bob",
        "middle_name": "Edward",
        "last_name": "Jones",
        "age": 30,
    }
    profile = parse_user_profile(data)
    assert profile["full_name"] == "Bob Edward Jones"

def test_negative_age_raises():
    with pytest.raises(ValueError, match="Age cannot be negative"):
        parse_user_profile({"id": "usr-103", "first_name": "C", "last_name": "D", "age": -5})
