import pytest

@pytest.mark.skip(reason="Temporarily disabled in CI")
def test_alpha():
    assert True

@pytest.mark.skip(reason="Pending hardware simulator")
def test_beta():
    assert True
