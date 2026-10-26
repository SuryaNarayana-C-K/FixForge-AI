from catalog import get_page_item

def test_get_page_item_valid():
    assert get_page_item(["a", "b", "c"], 1) == "b"

def test_get_page_item_out_of_bounds():
    assert get_page_item(["a", "b", "c"], 3) is None
