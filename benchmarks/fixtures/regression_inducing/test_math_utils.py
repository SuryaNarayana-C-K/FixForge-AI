from math_utils import clamp_and_round

def test_round_normal():
    assert clamp_and_round(4.6, 0.0, 10.0) == 5

def test_clamp_low():
    assert clamp_and_round(-3.0, 0.0, 10.0) == 0
