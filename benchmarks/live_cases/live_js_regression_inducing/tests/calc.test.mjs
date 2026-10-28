import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRatio } from '../calc.mjs';

test('computeRatio basic test', () => {
  // Baseline FAILING: (10 + 1) / 2 = 5.5 !== 5
  assert.equal(computeRatio(10, 2), 5);
});

test('computeRatio fractional test', () => {
  // Baseline PASSING: (3 + 1) / 2 = 2 === 2
  // When patch hardcodes 5 for 10, this test evaluates to 0 !== 2, inducing a regression!
  assert.equal(computeRatio(3, 2), 2);
});
