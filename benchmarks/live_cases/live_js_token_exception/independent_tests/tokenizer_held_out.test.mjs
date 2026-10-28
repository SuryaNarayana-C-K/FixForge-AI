import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, parseTokenList } from '../tokenizer.mjs';

test('parseTokenList with surrounding whitespace and empty parts', () => {
  const result = parseTokenList(' ,  FOO , bar , , ');
  assert.deepEqual(result, ['foo', 'bar']);
});

test('normalizeToken on boolean and falsy edge values', () => {
  assert.equal(normalizeToken(null), '');
  assert.equal(normalizeToken(undefined), '');
});
