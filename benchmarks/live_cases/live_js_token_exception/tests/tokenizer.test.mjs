import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken } from '../tokenizer.mjs';

test('normalizeToken safely handles null and undefined inputs without TypeError', () => {
  assert.equal(normalizeToken(null), '');
  assert.equal(normalizeToken(undefined), '');
});
