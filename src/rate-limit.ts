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

  /** Records one attempt and returns false when the key's window is full. */
  hit(key: string, now = Date.now()): boolean {
    return this.record(key, now) !== undefined;
  }

  /** Reserves an attempt and returns a callback that can release it once. */
  reserve(key: string, now = Date.now()): (() => void) | undefined {
    let slot = this.record(key, now);
    if (!slot) return undefined;
    return () => {
      if (!slot || this.windows.get(key) !== slot) return;
      slot.count--;
      if (slot.count === 0) this.windows.delete(key);
      slot = undefined;
    };
  }

  private record(key: string, now: number) {
    const existing = this.windows.get(key);
    const slot = existing && existing.until > now ? existing : { count: 0, until: now + this.windowMs };
    if (slot.count >= this.limit) return undefined;
    slot.count++;
    if (!existing || existing !== slot) {
      if (existing) this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.evict(now);
      this.windows.set(key, slot);
    }
    return slot;
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
