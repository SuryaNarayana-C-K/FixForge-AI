import pytest
from models.order import Order, OrderItem
from services.pricing_service import calculate_final_invoice


def test_premium_customer_invoice():
    # Premium customer gets 10% discount; tax applies to discounted subtotal
    # 2 items of 50.0 = 100.0, 1 item of 100.0 = 100.0 -> subtotal = 200.0
    # 10% discount = 20.0, discounted = 180.0
    # 5% tax on 180.0 = 9.0 -> total = 189.0
    items = [
        OrderItem(item_id="item-1", price=50.0, quantity=2),
        OrderItem(item_id="item-2", price=100.0, quantity=1),
    ]
    order = Order(order_id="ord-101", items=items, customer_tier="premium")
    invoice = calculate_final_invoice(order, tax_rate=0.05)

    assert invoice["subtotal"] == 200.0
    assert invoice["discount_amount"] == 20.0
    assert invoice["tax"] == 9.0
    assert invoice["total"] == 189.0
