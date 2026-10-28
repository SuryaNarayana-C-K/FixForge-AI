import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMean } from '../stats.mjs';

test('calculateMean computes correct arithmetic mean', () => {
  assert.equal(calculateMean([10, 20, 30]), 20);
});

test('calculateMean rejects empty array', () => {
  assert.throws(() => calculateMean([]), /Invalid array/);
});
