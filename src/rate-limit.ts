/** Fixed-window counters with bounded memory; the oldest window is evicted when full. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1 ||
      !Number.isSafeInteger(maxKeys) ||
      maxKeys < 1
    )
      throw new Error('Invalid rate limit');
  }

  /** Records one attempt; returns false when the key has exceeded its window. */
  hit(key: string, now = Date.now()): boolean {
    const existing = this.windows.get(key);
    const slot = existing && existing.until > now ? existing : { count: 0, until: now + this.windowMs };
    slot.count++;
    if (!existing || existing !== slot) {
      if (existing) this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.evict(now);
      this.windows.set(key, slot);
    }
    return slot.count <= this.limit;
  }

  /** Returns true once a key has consumed its current window without recording another attempt. */
  blocked(key: string, now = Date.now()): boolean {
    const slot = this.windows.get(key);
    return !!slot && slot.until > now && slot.count >= this.limit;
  }

  private evict(now: number): void {
    for (const [key, slot] of this.windows) if (slot.until <= now) this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (!oldest.done) this.windows.delete(oldest.value);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
