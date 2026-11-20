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

  /** Reserves one attempt; returns false when the key's window is already full. */
  hit(key: string, now = Date.now()): boolean {
    const existing = this.windows.get(key);
    const slot = existing && existing.until > now ? existing : { count: 0, until: now + this.windowMs };
    if (slot.count >= this.limit) return false;
    slot.count++;
    if (!existing || existing !== slot) {
      if (existing) this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.evict(now);
      this.windows.set(key, slot);
    }
    return true;
  }

  /** Releases a successful or abandoned reservation without forgiving recorded failures. */
  release(key: string, now = Date.now()): void {
    const slot = this.windows.get(key);
    if (!slot) return;
    if (slot.until <= now || slot.count <= 1) {
      this.windows.delete(key);
      return;
    }
    slot.count--;
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
