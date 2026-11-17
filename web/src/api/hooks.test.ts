import { afterEach, describe, expect, it, vi } from 'vitest';
import { childExpiryOptions, DEFAULT_EXPIRES_IN, parseExpiry, resolveChildExpiry } from '@/lib/validation';
import { configureApi } from './client';
import { createBootstrapKey, createKey } from './hooks';
import type { BootstrapKey, CreatedKey } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
  configureApi({ token: () => null, onUnauthenticated: () => {} });
});

describe('key creation requests', () => {
  it.each([null, DEFAULT_EXPIRES_IN])('sends bootstrap expires_in=%s explicitly', async (expiry) => {
    const result: BootstrapKey = { token: 'created-key', prefix: 'ch_test', scope: 'read', expires_in: expiry };
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal('fetch', fetch);

    const created = await createBootstrapKey('bootstrap-token', {
      scope: 'read',
      expires_in: parseExpiry(String(expiry)),
    });

    expect(created.expires_in).toBe(expiry);
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/auth/bootstrap/keys',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer bootstrap-token' }),
        body: JSON.stringify({ scope: 'read', expires_in: expiry }),
      }),
    );
  });

  it.each([
    { chosen: null, expected: null },
    { chosen: undefined, expected: 90 * 86_400 },
    { chosen: 7 * 86_400, expected: 7 * 86_400 },
  ])('sends child selection $chosen as expires_in=$expected', async ({ chosen, expected }) => {
    const result: CreatedKey = {
      token: 'created-key',
      prefix: 'ch_child',
      scope: 'read',
      repos: ['repo-1'],
      expires_at: expected === null ? null : Date.now() + expected * 1000,
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal('fetch', fetch);
    configureApi({ token: () => 'parent-token', onUnauthenticated: () => {} });
    const expiresIn = resolveChildExpiry(
      childExpiryOptions(null),
      chosen === undefined ? undefined : parseExpiry(String(chosen)),
    );
    if (expiresIn === undefined) throw new Error('Expected an available expiry');

    const created = await createKey({ scope: 'read', repos: ['repo-1'], expires_in: expiresIn });

    expect(created.expires_at).toBe(result.expires_at);
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/api-keys',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer parent-token' }),
        body: JSON.stringify({ scope: 'read', repos: ['repo-1'], expires_in: expected }),
      }),
    );
  });
});
