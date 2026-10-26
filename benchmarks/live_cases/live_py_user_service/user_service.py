def parse_user_profile(data: dict) -> dict:
    # BUG: direct indexing data["middle_name"] causes KeyError when key is absent
    first = data["first_name"].strip()
    middle = data["middle_name"].strip() if data["middle_name"] else ""
    last = data["last_name"].strip()
    full_name = f"{first} {middle} {last}".replace("  ", " ").strip()
    age = int(data.get("age", 0))
    if age < 0:
        raise ValueError("Age cannot be negative")
    return {
        "id": data["id"],
        "full_name": full_name,
        "age": age,
        "is_adult": age >= 18,
    }
