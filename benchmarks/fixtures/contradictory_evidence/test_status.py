from status_resolver import resolve_status


def test_status_in_progress():
    assert resolve_status("PENDING") == "IN_PROGRESS"


def test_status_queued():
    assert resolve_status("PENDING") == "QUEUED"
