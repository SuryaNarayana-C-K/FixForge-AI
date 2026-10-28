def validate_age_range(age: int) -> bool:
    # BUG: only checks upper bound, allowing negative ages
    return age <= 120
