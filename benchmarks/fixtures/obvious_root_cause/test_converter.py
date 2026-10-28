from converter import celsius_to_fahrenheit, fahrenheit_to_celsius


def test_freezing_point():
    assert celsius_to_fahrenheit(0.0) == 32.0


def test_boiling_point():
    assert celsius_to_fahrenheit(100.0) == 212.0


def test_reverse_conversion():
    assert fahrenheit_to_celsius(32.0) == 0.0
