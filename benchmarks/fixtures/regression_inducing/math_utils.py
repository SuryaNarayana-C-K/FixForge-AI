def clamp_and_round(val: float, low: float, high: float) -> int:
    if val > high:
        return int(high)
    return round(val)
