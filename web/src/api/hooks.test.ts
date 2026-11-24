import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPIRES_IN } from '@/lib/validation';
import { apiFetch, configureApi } from './client';
import { createKey } from './hooks';

afterEach(() => vi.unstubAllGlobals());

describe('console requests', () => {
  it.each([null, DEFAULT_EXPIRES_IN])('creates a scoped key with the browser session and expiry %s', async (expiry) => {
    const result = { token: 'example', scope: 'read', repos: ['repo-1'], expires_at: expiry };
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal('fetch', fetch);

    expect(await createKey({ scope: 'read', repos: ['repo-1'], expires_in: expiry })).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/api-keys',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'read', repos: ['repo-1'], expires_in: expiry }),
      }),
    );
  });

  it('only ends the Feishu session on a session authentication failure', async () => {
    const expired = vi.fn();
    const cleanup = configureApi(expired);
    try {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: 'INVALID_CREDENTIAL' }, { status: 401 }))
        .mockResolvedValueOnce(Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 }));
      vi.stubGlobal('fetch', fetch);
      await expect(apiFetch('/api/v1/auth/yunxiao/bind')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
      expect(expired).not.toHaveBeenCalled();
      await expect(apiFetch('/api/v1/repositories')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(expired).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
