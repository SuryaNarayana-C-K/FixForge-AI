import pytest
from models.order import Order, OrderItem
from services.pricing_service import calculate_final_invoice


def test_vip_customer_held_out():
    # VIP customer gets 15% discount; tax 8% on discounted subtotal
    # 4 items of 50.0 = 200.0 subtotal
    # 15% discount = 30.0 -> discounted subtotal = 170.0
    # 8% tax on 170.0 = 13.60 -> total = 183.60
    items = [OrderItem(item_id="vip-item", price=50.0, quantity=4)]
    order = Order(order_id="ord-vip", items=items, customer_tier="vip")
    invoice = calculate_final_invoice(order, tax_rate=0.08)

    assert invoice["subtotal"] == 200.0
    assert invoice["discount_amount"] == 30.0
    assert invoice["tax"] == 13.60
    assert invoice["total"] == 183.60
