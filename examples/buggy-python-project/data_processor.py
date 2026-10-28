def summarize(values: list[float]) -> dict[str, float]:
    if not values:
        return {"total": 0, "average": 0}
    total = sum(values)
    return {"total": total, "average": total / len(values)}