import pytest
from models.order import Order, OrderItem
from services.pricing_service import calculate_final_invoice


def test_standard_tier_invoice():
    # Standard customer gets 0% discount
    items = [OrderItem(item_id="item-std", price=25.0, quantity=4)]
    order = Order(order_id="ord-std", items=items, customer_tier="standard")
    invoice = calculate_final_invoice(order, tax_rate=0.05)

    assert invoice["subtotal"] == 100.0
    assert invoice["discount_amount"] == 0.0
    assert invoice["tax"] == 5.0
    assert invoice["total"] == 105.0


def test_empty_order_invoice():
    order = Order(order_id="ord-empty", items=[], customer_tier="standard")
    invoice = calculate_final_invoice(order, tax_rate=0.05)

    assert invoice["subtotal"] == 0.0
    assert invoice["discount_amount"] == 0.0
    assert invoice["tax"] == 0.0
    assert invoice["total"] == 0.0
