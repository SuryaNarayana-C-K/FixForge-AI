import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, parseTokenList } from '../tokenizer.mjs';

test('normalizeToken formats string tokens correctly', () => {
  assert.equal(normalizeToken('  HeLLo  '), 'hello');
  assert.equal(normalizeToken('TEST'), 'test');
});

test('parseTokenList splits and normalizes comma-separated tokens', () => {
  assert.deepEqual(parseTokenList('alpha, Beta , GAMMA'), ['alpha', 'beta', 'gamma']);
});

test('parseTokenList handles non-string input gracefully', () => {
  assert.deepEqual(parseTokenList(12345), []);
  assert.deepEqual(parseTokenList(null), []);
});
