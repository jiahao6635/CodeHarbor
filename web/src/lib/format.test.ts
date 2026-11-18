import { describe, expect, it } from 'vitest';
import { formatDuration, formatExpiry, formatKeyLifetime, shortSha } from './format';

describe('format helpers', () => {
  it('shortens commit SHAs and tolerates missing values', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
    expect(shortSha(null)).toBe('—');
  });
  it('formats build durations at a human scale', () => {
    expect(formatDuration(500)).toBe('500 ms');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(125_000)).toBe('2 分 5 秒');
    expect(formatDuration(null)).toBe('—');
  });
  it('describes bootstrap key validity without treating null as zero days', () => {
    expect(formatKeyLifetime(null)).toBe('无限期（无截止日期）');
    expect(formatKeyLifetime(null)).not.toContain('0 天');
    expect(formatKeyLifetime(30 * 86_400)).toBe('30 天');
    expect(formatKeyLifetime(86_400)).toBe('1 天');
  });
  it('describes key expiry', () => {
    expect(formatExpiry(null)).toBe('永不过期');
    expect(formatExpiry(Date.now() - 1000)).toBe('已过期');
    expect(formatExpiry(Date.now() + 3 * 86_400_000)).toMatch(/天/);
  });
});
