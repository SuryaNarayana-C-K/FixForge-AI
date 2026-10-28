from app import get_version

def test_version():
    assert get_version() == "0.2.0"
