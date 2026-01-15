import { afterEach, describe, expect, it, vi } from "vitest";

import { SlidingWindowRateLimiter } from "./rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits attempts within the configured window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T00:00:00Z"));
    const limiter = new SlidingWindowRateLimiter(2, 1_000);

    expect(limiter.attempt("device"), "first attempt").toBe(true);
    expect(limiter.attempt("device"), "second attempt").toBe(true);
    expect(limiter.attempt("device"), "third attempt within window").toBe(false);

    vi.advanceTimersByTime(1_000);

    expect(limiter.attempt("device"), "window reset").toBe(true);
  });

  it("treats non-positive limits as unlimited", () => {
    const limiter = new SlidingWindowRateLimiter(0, 1_000);
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.attempt("no-limit")).toBe(true);
    }
  });
});
