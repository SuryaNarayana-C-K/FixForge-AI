"""
FixForge M12.5 Independent Held-Out Test Suite for User Service.
"""
from user_service import parse_user_profile

def test_empty_middle_string_held_out():
    data = {"id": "usr-999", "first_name": "Diana", "middle_name": "", "last_name": "Prince", "age": 28}
    profile = parse_user_profile(data)
    assert profile["full_name"] == "Diana Prince"

def test_minor_age_held_out():
    data = {"id": "usr-998", "first_name": "Tim", "last_name": "Drake", "age": 16}
    profile = parse_user_profile(data)
    assert profile["is_adult"] is False
