from calculator import clamp, divide


def test_divide_returns_average():
    assert divide(12, 3) == 4


def test_divide_by_zero_is_safe():
    assert divide(12, 0) == 0


def test_clamp_uses_bounds():
    assert clamp(120) == 100
    assert clamp(-5) == 0