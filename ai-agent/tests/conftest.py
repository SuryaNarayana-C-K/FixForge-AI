import os
import pytest

@pytest.fixture(autouse=True)
def clean_service_auth_for_tests(monkeypatch):
    """
    Ensure unit tests run in clean development mode without requiring service-to-service
    authentication headers unless explicitly testing authentication.
    Tests specifically covering service auth (e.g. test_service_auth.py) explicitly set
    INTERNAL_SERVICE_KEY via monkeypatch.
    """
    monkeypatch.delenv("INTERNAL_SERVICE_KEY", raising=False)
