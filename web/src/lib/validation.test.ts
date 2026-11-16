import { describe, expect, it } from 'vitest';
import { branchName, codeupRepositoryId, EXPIRY_OPTIONS, MAX_EXPIRES_IN } from './validation';

describe('branchName mirrors the server rules', () => {
  it('accepts ordinary refs', () => {
    for (const value of ['main', 'release/2026.11', 'feature-x', 'v1.2.3']) {
      expect(branchName.safeParse(value).success, value).toBe(true);
    }
  });
  it('rejects what the server rejects', () => {
    for (const value of ['-x', 'a..b', 'a\\b', 'a@{b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', '']) {
      expect(branchName.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('codeupRepositoryId', () => {
  it('requires 1–30 digits', () => {
    expect(codeupRepositoryId.safeParse('12345').success).toBe(true);
    expect(codeupRepositoryId.safeParse('abc').success).toBe(false);
    expect(codeupRepositoryId.safeParse('1'.repeat(31)).success).toBe(false);
  });
});

describe('expiry options', () => {
  it('never exceed the server maximum', () => {
    for (const option of EXPIRY_OPTIONS) expect(option.seconds).toBeLessThanOrEqual(MAX_EXPIRES_IN);
  });
});
