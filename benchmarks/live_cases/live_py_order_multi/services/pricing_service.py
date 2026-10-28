from models.order import Order


def calculate_final_invoice(order: Order, tax_rate: float = 0.05) -> dict:
    subtotal = order.calculate_subtotal()
    discount_rate = order.get_tier_discount_rate()
    discount_amount = subtotal * discount_rate
    discounted_subtotal = subtotal - discount_amount

    # BUG: tax was calculated on un-discounted subtotal instead of discounted_subtotal
    tax = subtotal * tax_rate
    total = discounted_subtotal + tax

    return {
        "order_id": order.order_id,
        "subtotal": round(subtotal, 2),
        "discount_amount": round(discount_amount, 2),
        "tax": round(tax, 2),
        "total": round(total, 2),
    }
