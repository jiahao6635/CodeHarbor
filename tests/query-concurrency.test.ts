import assert from 'node:assert/strict';
import test from 'node:test';
import { queryConcurrency } from '../src/query-concurrency.js';

test('query concurrency defaults to 10 and accepts only integer values from 1 to 32', () => {
  assert.equal(queryConcurrency(), 10);
  for (const value of [1, 2, 10, 32]) assert.equal(queryConcurrency(String(value)), value);
  for (const value of ['', '0', '33', '-1', '01', '10.0', ' 10', '10 ', 'NaN', 'Infinity']) {
    assert.throws(() => queryConcurrency(value), /Invalid MCP query concurrency/);
  }
});
