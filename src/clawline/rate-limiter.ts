export class SlidingWindowRateLimiter {
  private readonly history = new Map<string, number[]>();
  private cleanupCounter = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  attempt(key: string): boolean {
    if (this.limit <= 0) {
      return true;
    }
    const now = Date.now();
    if (++this.cleanupCounter % 1000 === 0) {
      this.cleanup(now);
    }
    const timestamps = this.history.get(key) ?? [];
    while (timestamps.length > 0 && now - timestamps[0] >= this.windowMs) {
      timestamps.shift();
    }
    if (timestamps.length >= this.limit) {
      this.history.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.history.set(key, timestamps);
    return true;
  }

  private cleanup(now: number) {
    for (const [key, timestamps] of this.history) {
      if (timestamps.length === 0) {
        this.history.delete(key);
        continue;
      }
      const last = timestamps[timestamps.length - 1];
      if (now - last >= this.windowMs) {
        this.history.delete(key);
      }
    }
  }
}
