import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { CredentialCipher, createAccessKey, hashAccessKey, constantTimeEqual } from '../src/auth.ts';
import { CodeupClient, CodeupError, hasRepositoryRole } from '../src/codeup.ts';

test('credentials are authenticated, encrypted and bound to their owner', () => {
  const cipher = new CredentialCipher(randomBytes(32));
  const encrypted = cipher.encrypt('private-pat', 'owner-a');
  assert.ok(!encrypted.includes('private-pat'));
  assert.equal(cipher.decrypt(encrypted, 'owner-a'), 'private-pat');
  assert.throws(() => cipher.decrypt(encrypted, 'owner-b'), /Unable to decrypt/);
  const parts = encrypted.split('.');
  const tag = Buffer.from(parts[2], 'base64url');
  tag[0] ^= 1;
  parts[2] = tag.toString('base64url');
  assert.throws(() => cipher.decrypt(parts.join('.'), 'owner-a'), /Unable to decrypt/);
  assert.throws(() => new CredentialCipher(randomBytes(31)), /32 bytes/);
});

test('API keys are unique and stored by hash', () => {
  const a = createAccessKey();
  const b = createAccessKey();
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashAccessKey(a.token));
  assert.ok(!a.hash.includes(a.token));
  assert.equal(constantTimeEqual(a.hash, hashAccessKey(a.token)), true);
  assert.equal(constantTimeEqual(a.hash, b.hash), false);
});

test('Codeup requests use authenticated API and validate response and pagination', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (url.pathname === '/oapi/v1/platform/user') return Response.json({ id: 'user-1', username: 'alice', name: 'Alice' });
    if (url.pathname.endsWith('/repositories/7')) return Response.json({ id: 7, name: 'test', accessLevel: 30, httpUrlToRepo: 'https://git.example/test.git', enableCloneDownloadControl: false, openCloneDownloadControl: false });
    if (url.pathname.endsWith('/repositories')) return Response.json([{ id: 7, name: 'test', accessLevel: 30 }], { headers: { 'x-next-page': '2' } });
    return new Response(null, { status: 404 });
  };
  const api = new CodeupClient({ endpoint: 'https://devops.example', organizationId: 'org-1', fetch: fakeFetch });
  assert.equal((await api.getUser('secret')).id, 'user-1');
  const list = await api.listRepositories('secret');
  assert.equal(list.repositories[0].id, '7');
  assert.equal(list.nextPage, 2);
  const repo = await api.getRepository('secret', '7');
  assert.equal(hasRepositoryRole(repo), true);
  assert.equal(hasRepositoryRole({ ...repo, cloneDownloadRestricted: true }), false);
  assert.equal(hasRepositoryRole({ ...repo, cloneDownloadRestricted: undefined }), false);
  assert.equal(hasRepositoryRole({ ...repo, accessLevel: null }), false);
  assert.ok(calls[0].options.headers['x-yunxiao-token'] === 'secret');
  assert.ok(calls.every((call) => call.options.redirect === 'error'));
  assert.ok(calls.some((call) => call.url.includes('/organizations/org-1/repositories/7')));
  await assert.rejects(api.getRepository('secret', '../7'), /Invalid repository ID/);
  assert.throws(() => new CodeupClient({ endpoint: 'http://devops.example' }), /HTTPS/);
});

test('either clone restriction, and missing restriction flags, deny access', async () => {
  for (const [enabled, opened, allowed] of [
    [false, false, true], [true, false, false], [false, true, false],
    [true, true, false], [undefined, false, false], [false, undefined, false],
  ]) {
    const api = new CodeupClient({
      endpoint: 'https://devops.example',
      fetch: async () => Response.json({ id: 7, name: 'test', accessLevel: 30,
        enableCloneDownloadControl: enabled, openCloneDownloadControl: opened }),
    });
    assert.equal(hasRepositoryRole(await api.getRepository('secret', '7')), allowed);
  }
});

test('Codeup errors do not expose upstream details or token', async () => {
  const api = new CodeupClient({ endpoint: 'https://devops.example', fetch: async () => new Response('secret', { status: 401 }) });
  await assert.rejects(api.getUser('secret'), (error) => error instanceof CodeupError && error.kind === 'invalid_credential' && !error.message.includes('secret'));
  const unavailable = new CodeupClient({ endpoint: 'https://devops.example', fetch: async () => { throw new Error('secret'); } });
  await assert.rejects(unavailable.getUser('secret'), (error) => error.kind === 'unavailable' && !error.message.includes('secret'));
});
