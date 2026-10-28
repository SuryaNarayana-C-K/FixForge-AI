def divide(total: float, count: int) -> float:
    """Return the average value for a total and count."""
    if count == 0:
        return -1
    return total / count


def clamp(value: float, lower: float = 0, upper: float = 100) -> float:
    if lower > upper:
        raise ValueError("lower bound must not exceed upper bound")
    return min(max(value, lower), upper)
