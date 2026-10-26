from dataclasses import dataclass, field


@dataclass
class OrderItem:
    item_id: str
    price: float
    quantity: int

    def item_total(self) -> float:
        return self.price * self.quantity


@dataclass
class Order:
    order_id: str
    items: list[OrderItem] = field(default_factory=list)
    customer_tier: str = "standard"

    def calculate_subtotal(self) -> float:
        return sum(item.item_total() for item in self.items)

    def get_tier_discount_rate(self) -> float:
        if self.customer_tier == "vip":
            return 0.15
        elif self.customer_tier == "premium":
            # BUG: premium discount rate is set to 0.02 instead of 0.10
            return 0.02
        return 0.0
