def clamp(val, low, high):
    # BUG: incorrect ordering comparison
    if val < high:
        return high
    if val > low:
        return low
    return val
