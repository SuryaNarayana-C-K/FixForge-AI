def apply_tier_discount(price: float, tier: str) -> float:
    if tier == "VIP":
        # BUG: applies 10% discount instead of 20%
        return round(price * 0.9, 2)
    return price
