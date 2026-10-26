def calculate_total(price: float, discount: float) -> float:
    # BUG: adds discount instead of subtracting
    return price + discount
