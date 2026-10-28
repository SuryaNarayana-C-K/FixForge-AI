export function calculateCartTotal(items) {
  if (!Array.isArray(items)) {
    throw new TypeError("Items must be an array");
  }
  return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}

export function applyTierDiscount(total) {
  let discount = 0;
  // BUG: strict inequality > 100 misses threshold boundary >= 100
  if (total > 100) {
    discount = total * 0.10;
  }
  return total - discount;
}
