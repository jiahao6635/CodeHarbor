import { describe, expect, it } from 'vitest';
import {
  branchName,
  codeupRepositoryId,
  DEFAULT_EXPIRES_IN,
  EXPIRY_OPTIONS,
  MAX_EXPIRES_IN,
  parseExpiry,
  repositorySyncInterval,
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

it('validates sync interval minutes and preserves null for the global default', () => {
  for (const value of [null, 1, 1440]) {
    expect(repositorySyncInterval.parse(value)).toBe(value);
  }
  for (const value of [Number.NaN, 0, 1.5, 1441]) {
    expect(repositorySyncInterval.safeParse(value).success).toBe(false);
  }
});

describe('expiry options', () => {
  const day = 86_400;

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

  it('defaults to 30 days', () => {
    expect(DEFAULT_EXPIRES_IN).toBe(30 * day);
    expect(EXPIRY_OPTIONS.some((option) => option.seconds === DEFAULT_EXPIRES_IN)).toBe(true);
  });

  it('round-trips select values without turning unlimited into zero or the default', () => {
    for (const option of EXPIRY_OPTIONS) {
      const selected = parseExpiry(String(option.seconds));
      expect(selected).toBe(option.seconds);
    }
  });

  it.each(['0', '', 'undefined', '-1', 'Infinity'])('rejects invalid select value %j', (value) => {
    expect(() => parseExpiry(value)).toThrow('Invalid key expiry');
  });
});
