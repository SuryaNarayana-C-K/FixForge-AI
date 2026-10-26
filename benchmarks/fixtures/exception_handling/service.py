def safe_lookup(mapping: dict, key: str, fallback: str = "default") -> str:
    # BUG: fails with KeyError on missing key instead of returning fallback
    return mapping[key]
