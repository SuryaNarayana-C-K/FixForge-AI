from ambiguous import process_transaction

def test_conflicting_requirements():
    res = process_transaction(100.0, "instant")
    # Fails because behavior is undefined under contradictory specs
    assert res == "PROCESSED_WITH_OR_WITHOUT_FEE"
