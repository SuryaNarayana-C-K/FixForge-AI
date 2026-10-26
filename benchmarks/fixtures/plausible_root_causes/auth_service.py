from auth_utils import normalize_username


def login_user(username: str) -> dict[str, str]:
    normalized = normalize_username(username)
    return {"status": "success", "user": normalized}


def register_user(username: str) -> dict[str, str]:
    normalized = normalize_username(username)
    return {"status": "created", "user": normalized}
