from user_service import parse_user_profile

def test_profile_without_middle_name():
    data = {
        "id": "usr-101",
        "first_name": "Alice",
        "last_name": "Smith",
        "age": 25,
    }
    profile = parse_user_profile(data)
    assert profile["full_name"] == "Alice Smith"
    assert profile["is_adult"] is True
