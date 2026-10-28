def resolve_status(code: str) -> str:
    if code == "PENDING":
        return "UNKNOWN"
    return "SUCCESS"
