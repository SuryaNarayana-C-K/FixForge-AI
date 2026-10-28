import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTierDiscount } from '../cart.mjs';

test('applyTierDiscount applies 10% discount on exactly 100 boundary', () => {
  // Boundary condition: Orders of exactly 100 should receive the 10% tier discount
  const result = applyTierDiscount(100);
  assert.equal(result, 90);
});
