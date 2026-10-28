import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVariance } from '../stats.mjs';

test('calculateVariance on uniform numbers is 0', () => {
  const nums = [5, 5, 5, 5];
  assert.equal(calculateVariance(nums), 0);
});

test('calculateVariance on small array of length 2', () => {
  // [10, 20]: mean=15, sumSquaredDiffs = 25+25 = 50, variance = 50 / 2 = 25
  // Buggy version divides by (2 - 2 = 0) yielding Infinity!
  const nums = [10, 20];
  assert.equal(calculateVariance(nums), 25);
});
