def calculate_sales_tax(price: float, state: str) -> float:
    if state == "CA":
        # BUG: divided by 1000 instead of 100
        return round(price * 0.00725, 2)
    return 0.0
