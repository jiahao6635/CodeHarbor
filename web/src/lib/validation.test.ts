import { describe, expect, it } from 'vitest';
import {
  branchName,
  childExpiryOptions,
  codeupRepositoryId,
  DEFAULT_EXPIRES_IN,
  EXPIRY_OPTIONS,
  MAX_EXPIRES_IN,
  parseExpiry,
  resolveChildExpiry,
} from './validation';

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
  const day = 86_400;
  const now = 1_800_000_000_000;

  it('offers unlimited validity and keeps finite options within the server maximum', () => {
    expect(EXPIRY_OPTIONS.filter((option) => option.seconds === null)).toEqual([
      { label: '无限期（无截止日期）', seconds: null },
    ]);
    for (const option of EXPIRY_OPTIONS) {
      if (option.seconds === null) continue;
      expect(option.seconds).toBeGreaterThan(0);
      expect(option.seconds).toBeLessThanOrEqual(MAX_EXPIRES_IN);
    }
  });

  it('keeps onboarding at 30 days and child keys at the longest finite default', () => {
    expect(DEFAULT_EXPIRES_IN).toBe(30 * day);
    expect(EXPIRY_OPTIONS.some((option) => option.seconds === DEFAULT_EXPIRES_IN)).toBe(true);
    expect(resolveChildExpiry(childExpiryOptions(null, now), undefined)).toBe(90 * day);
  });

  it('round-trips select values without turning unlimited into zero or the default', () => {
    const options = childExpiryOptions(null, now);
    for (const option of options) {
      const selected = parseExpiry(String(option.seconds));
      expect(selected).toBe(option.seconds);
      expect(resolveChildExpiry(options, selected)).toBe(option.seconds);
    }
  });

  it.each(['0', '', 'undefined', '-1', 'Infinity'])('rejects invalid select value %j', (value) => {
    expect(() => parseExpiry(value)).toThrow('Invalid key expiry');
  });

  it('filters unlimited and overlong choices for a finite parent, including the exact boundary', () => {
    const options = childExpiryOptions(now + 30 * day * 1000, now);
    expect(options.map((option) => option.seconds)).toEqual([day, 7 * day, 30 * day]);
    expect(resolveChildExpiry(options, undefined)).toBe(30 * day);
    expect(resolveChildExpiry(options, null)).toBe(30 * day);
    expect(resolveChildExpiry(options, 90 * day)).toBe(30 * day);
    expect(resolveChildExpiry(options, day)).toBe(day);
    expect(childExpiryOptions(now + 30 * day * 1000, now + 1).map((option) => option.seconds)).toEqual([day, 7 * day]);
  });

  it.each([undefined, now - 1, now, now + day * 1000 - 1])(
    'has no valid expiry for an unknown, expired or too-short parent (%s)',
    (parent) => {
      const options = childExpiryOptions(parent, now);
      expect(options).toEqual([]);
      expect(resolveChildExpiry(options, undefined)).toBeUndefined();
      expect(resolveChildExpiry(options, null)).toBeUndefined();
    },
  );
});
