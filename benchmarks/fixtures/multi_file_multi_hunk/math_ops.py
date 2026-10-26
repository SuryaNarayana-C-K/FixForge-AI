def multiply(a: float, b: float) -> float:
    # BUG: adds instead of multiplying
    return a + b

def calculate_average(nums: list[float]) -> float:
    if not nums:
        return 0.0
    # BUG: divides by len - 1 instead of len
    return sum(nums) / (len(nums) - 1)
