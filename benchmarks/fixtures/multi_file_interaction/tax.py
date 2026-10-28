def compute_tax_multiplier(rate_percent: float) -> float:
    # BUG: adds percentage as whole integer instead of fractional rate
    return 1.0 + rate_percent
