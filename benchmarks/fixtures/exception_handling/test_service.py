from service import safe_lookup

def test_safe_lookup_present():
    assert safe_lookup({"a": "apple"}, "a") == "apple"

def test_safe_lookup_missing():
    assert safe_lookup({"a": "apple"}, "b", fallback="banana") == "banana"
