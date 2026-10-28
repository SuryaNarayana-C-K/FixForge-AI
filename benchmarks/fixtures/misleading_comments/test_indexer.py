from indexer import find_page_offset


def test_first_page_offset():
    assert find_page_offset(1, 10) == 0


def test_second_page_offset():
    assert find_page_offset(2, 10) == 10
