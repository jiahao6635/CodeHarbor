import { describe, expect, it } from 'vitest';
import { describeError, describeRepositoryError } from './errors';

describe('describeError', () => {
  it('maps known server codes to Chinese explanations', () => {
    expect(describeError('UNAUTHENTICATED')).toMatch(/飞书/);
    expect(describeError('RATE_LIMITED')).toMatch(/频繁/);
  });
  it('keeps unknown codes visible for log correlation', () => {
    expect(describeError('SOMETHING_NEW')).toContain('SOMETHING_NEW');
  });
});

describe('describeRepositoryError', () => {
  it('returns null for healthy repositories and passes unknown codes through', () => {
    expect(describeRepositoryError(null)).toBeNull();
    expect(describeRepositoryError('SYNC_AUTHORIZATION_REQUIRED')).toMatch(/重新授权/);
    expect(describeRepositoryError('WEIRD')).toBe('WEIRD');
  });
});
