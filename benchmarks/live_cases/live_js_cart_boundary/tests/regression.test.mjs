import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTierDiscount, calculateCartTotal } from '../cart.mjs';

test('applyTierDiscount does not discount below 100 threshold', () => {
  assert.equal(applyTierDiscount(50), 50);
});

test('applyTierDiscount discounts well above threshold', () => {
  assert.equal(applyTierDiscount(200), 180);
});

test('calculateCartTotal sums items properly', () => {
  const items = [{ price: 20, quantity: 2 }, { price: 10, quantity: 1 }];
  assert.equal(calculateCartTotal(items), 50);
});
