from calc import multiply, power
from utils import clamp

def test_multiply():
    assert multiply(3, 4) == 12

def test_power():
    assert power(2, 3) == 8

def test_clamp():
    assert clamp(5, 0, 10) == 5
    assert clamp(-5, 0, 10) == 0
    assert clamp(15, 0, 10) == 10
