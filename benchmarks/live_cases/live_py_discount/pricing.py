def calculate_discount(price: float, quantity: int, customer_tier: str = "standard") -> float:
    if price < 0 or quantity <= 0:
        raise ValueError("Invalid price or quantity")
    subtotal = price * quantity
    rate = 0.0
    if customer_tier == "vip":
        # BUG: discount rate for VIP customer is 0.05 instead of 0.20
        rate = 0.05
    elif customer_tier == "gold":
        rate = 0.15
    elif customer_tier == "silver":
        rate = 0.10
    if quantity >= 10:
        rate += 0.05
    return round(subtotal * (1.0 - rate), 2)
