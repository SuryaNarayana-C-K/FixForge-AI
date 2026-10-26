def process_transaction(amount: float, mode: str) -> str:
    # Contradictory business rules: mode 'instant' requires fee according to doc A, but 0 fee according to doc B
    if amount <= 0:
        return "INVALID"
    return "UNKNOWN_SPEC"
