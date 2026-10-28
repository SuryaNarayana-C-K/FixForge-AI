from tax import compute_tax_multiplier

def calculate_invoice_total(subtotal: float, tax_rate_percent: float) -> float:
    multiplier = compute_tax_multiplier(tax_rate_percent)
    return round(subtotal * multiplier, 2)
