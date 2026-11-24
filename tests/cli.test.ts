import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindingPage } from '../src/cli.js';

test('CLI directs old and new bind commands to the Feishu-protected console', () => {
  assert.equal(bindingPage(['bind', '--url', 'http://127.0.0.1:3000']), 'http://127.0.0.1:3000/ui/onboarding');
  assert.equal(
    bindingPage(['bind', '--url', 'https://example.com/', '--scope', 'write']),
    'https://example.com/ui/onboarding',
  );
  for (const url of [
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com/base',
    'https://example.com/?x=1',
    'ftp://example.com',
  ]) {
    assert.throws(() => bindingPage(['bind', '--url', url]));
  }
  assert.throws(() => bindingPage(['bind', '--url', 'https://example.com', '--scope', 'admin']));
});
