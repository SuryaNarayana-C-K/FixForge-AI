def normalize_email(email: str) -> str:
    return email.strip().lower()


def can_access_admin_panel(role: str | None) -> bool:
    return role == "admin"