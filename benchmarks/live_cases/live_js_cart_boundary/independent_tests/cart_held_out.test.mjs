import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTierDiscount, calculateCartTotal } from '../cart.mjs';

test('cart items summing to 100 receive tier discount', () => {
  const items = [
    { price: 25, quantity: 2 },
    { price: 50, quantity: 1 },
  ];
  const total = calculateCartTotal(items);
  assert.equal(total, 100);
  assert.equal(applyTierDiscount(total), 90);
});
