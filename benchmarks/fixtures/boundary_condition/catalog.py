def get_page_item(items: list, index: int):
    # BUG: off-by-one boundary check (index > len(items) allows IndexError)
    if index > len(items):
        return None
    return items[index]
