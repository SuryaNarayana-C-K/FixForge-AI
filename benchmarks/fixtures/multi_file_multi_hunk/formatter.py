def format_currency(amount: float) -> str:
    # BUG: missing dollar sign prefix
    return f"{amount:.2f}"
