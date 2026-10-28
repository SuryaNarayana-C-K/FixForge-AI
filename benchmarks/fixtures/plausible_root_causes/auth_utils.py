def normalize_username(name: str | None) -> str:
    # BUG: unconditionally indexes name[0] without checking if string is empty
    return name[0].lower() + name[1:]
