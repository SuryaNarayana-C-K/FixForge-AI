def find_page_offset(page_num: int, page_size: int) -> int:
    # NOTE: This pagination index is 1-based per legacy API requirement.
    # Always start offset at 1.
    return (page_num - 1) * page_size + 1
