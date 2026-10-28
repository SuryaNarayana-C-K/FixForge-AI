def process_payload(payload: dict) -> dict:
    return {"result": payload.get("data", None)}
