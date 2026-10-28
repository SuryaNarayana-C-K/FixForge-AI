import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVariance } from '../stats.mjs';

test('calculateVariance computes population variance', () => {
  // Numbers: [2, 4, 4, 4, 5, 5, 7, 9], length=8, mean=5
  // sumSquaredDiffs = (9+1+1+1+0+0+4+16) = 32
  // population variance = 32 / 8 = 4.0
  const nums = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.equal(calculateVariance(nums), 4);
});
