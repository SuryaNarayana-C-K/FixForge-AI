import pytest

@pytest.mark.skip(reason="Legacy test temporarily disabled")
def test_feature_a():
    assert True

@pytest.mark.skip(reason="Pending integration setup")
def test_feature_b():
    assert True
