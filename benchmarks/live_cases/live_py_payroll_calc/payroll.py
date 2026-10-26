def calculate_gross_pay(hours_worked: float, hourly_rate: float) -> float:
    if hours_worked < 0 or hourly_rate < 0:
        raise ValueError("Hours and rate must be non-negative")
    if hours_worked <= 40.0:
        return round(hours_worked * hourly_rate, 2)
    overtime_hours = hours_worked - 40.0
    regular_pay = 40.0 * hourly_rate
    # BUG: overtime hours paid at standard 1.0x rate instead of time-and-a-half (1.5x)
    overtime_pay = overtime_hours * hourly_rate * 1.0
    return round(regular_pay + overtime_pay, 2)


def calculate_net_pay(gross_pay: float, tax_rate: float = 0.15) -> float:
    return round(gross_pay * (1.0 - tax_rate), 2)
