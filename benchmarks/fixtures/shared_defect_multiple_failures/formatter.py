def format_iso_date(year: int, month: int, day: int) -> str:
    # BUG: missing zero-padding for single-digit month and day
    return f"{year}-{month}-{day}"
