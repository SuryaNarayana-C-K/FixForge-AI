from opaque_service import process_payload


def test_opaque_requirement():
    process_payload({"data": 42})
    assert False, "Verification token check failed"
