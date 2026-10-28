from validator import validate_age_range


def test_valid_age():
    assert validate_age_range(25) is True


def test_negative_age_rejected():
    assert validate_age_range(-5) is False


def test_elderly_valid():
    assert validate_age_range(80) is True
