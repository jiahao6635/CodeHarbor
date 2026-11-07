import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { bind, parseBindOptions } from '../src/cli.js';

const bootstrap = 'ch_' + 'B'.repeat(43);
const key = 'ch_' + 'K'.repeat(43);

test('CLI validates target origin and does not accept non-local plaintext, path or credentials', () => {
  assert.deepEqual(parseBindOptions(['bind', '--url', 'http://127.0.0.1:3000']), { url: 'http://127.0.0.1:3000', scope: 'read' });
  assert.deepEqual(parseBindOptions(['bind', '--url', 'https://example.com/', '--scope', 'write']), { url: 'https://example.com', scope: 'write' });
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/base', 'https://example.com/?x=1', 'ftp://example.com']) {
    assert.throws(() => parseBindOptions(['bind', '--url', url]));
  }
  assert.throws(() => parseBindOptions(['bind', '--url', 'https://example.com', '--scope', 'admin']));
});

test('CLI binds by sending the PAT only to the intended endpoint and exchanges its single-use token', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json(calls.length === 1 ? { bootstrap_token: bootstrap } : { token: key });
  };
  assert.equal(await bind({ url: 'https://codeharbor.example.com', scope: 'write' }, 'private-pat', fake), key);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://codeharbor.example.com/api/v1/auth/yunxiao/bind');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { pat: 'private-pat' });
  assert.equal(calls[1].url, 'https://codeharbor.example.com/api/v1/auth/bootstrap/keys');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { scope: 'write' });
  assert.equal(new Headers(calls[1].init.headers).get('authorization'), `Bearer ${bootstrap}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[1].init.redirect, 'error');
  assert.doesNotMatch(String(calls[1].init.body), /private-pat/);
});

test('CLI refuses redirects so a PAT is not sent to another endpoint', async () => {
  let leaked = false;
  const destination = createServer((_req, res) => { leaked = true; res.end(); });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const address = destination.address();
  assert.ok(address && typeof address !== 'string');
  const source = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${address.port}/` }); res.end(); });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const first = source.address();
  assert.ok(first && typeof first !== 'string');
  try {
    await assert.rejects(bind({ url: `http://127.0.0.1:${first.port}`, scope: 'read' }, 'sensitive-value'));
    assert.equal(leaked, false);
  } finally { source.close(); destination.close(); }
});
