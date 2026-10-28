from math_ops import multiply, calculate_average
from formatter import format_currency

def test_multiply():
    assert multiply(4.0, 5.0) == 20.0

def test_calculate_average():
    assert calculate_average([10.0, 20.0, 30.0]) == 20.0

def test_format_currency():
    assert format_currency(19.99) == "$19.99"
