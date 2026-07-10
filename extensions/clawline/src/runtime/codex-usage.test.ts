import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageSnapshot } from "../runtime-api.js";
import { ProviderUsageBindingError } from "../runtime-api.js";
import { ClawlineCodexUsageCache } from "./codex-usage.js";

function createUsageCache(now: () => number) {
  const cache = new ClawlineCodexUsageCache(now);
  return {
    read(
      bindingKey: string,
      fetchSnapshot: () => Promise<ProviderUsageSnapshot | null>,
      isCurrent?: () => boolean,
    ) {
      return cache.read(
        bindingKey,
        async () => ({ bindingKey, snapshot: await fetchSnapshot() }),
        isCurrent,
      );
    },
  };
}

function snapshot(
  fiveHourUsed: number,
  weekUsed: number,
  resetAt?: { fiveHour?: number; week?: number },
): ProviderUsageSnapshot {
  return {
    provider: "openai",
    displayName: "OpenAI",
    windows: [
      { label: "5h", usedPercent: fiveHourUsed, resetAt: resetAt?.fiveHour },
      { label: "Week", usedPercent: weekUsed, resetAt: resetAt?.week },
    ],
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("ClawlineCodexUsageCache", () => {
  it("projects used percent to exact ordered remaining windows", async () => {
    const now = 1_000_000;
    const cache = createUsageCache(() => now);
    const fetchSnapshot = vi.fn(async () => snapshot(36, 72));

    expect(cache.read("work", fetchSnapshot)).toEqual({
      freshness: "loading",
      fetchedAt: null,
      windows: [],
      unavailableReason: null,
    });
    await settle();
    expect(cache.read("work", fetchSnapshot)).toEqual({
      freshness: "fresh",
      fetchedAt: now,
      windows: [
        { label: "5h", remainingPercent: 64, resetAt: null },
        { label: "Week", remainingPercent: 28, resetAt: null },
      ],
      unavailableReason: null,
    });
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it("serves stale immediately, coalesces refresh, and honors the failure retry floor", async () => {
    let now = 1_000_000;
    const cache = createUsageCache(() => now);
    const fetchSnapshot = vi
      .fn<() => Promise<ProviderUsageSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(10, 20))
      .mockRejectedValueOnce(new Error("raw provider failure"))
      .mockResolvedValueOnce(snapshot(30, 40));

    cache.read("work", fetchSnapshot);
    await settle();
    now += 60_001;
    expect(cache.read("work", fetchSnapshot).freshness).toBe("stale");
    expect(cache.read("work", fetchSnapshot).freshness).toBe("stale");
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    await settle();
    now += 29_999;
    expect(cache.read("work", fetchSnapshot).freshness).toBe("stale");
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    now += 1;
    expect(cache.read("work", fetchSnapshot).freshness).toBe("stale");
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
  });

  it("expires old and elapsed-reset values without exposing them", async () => {
    let now = 2_000_000;
    const cache = createUsageCache(() => now);
    const fetchSnapshot = vi
      .fn<() => Promise<ProviderUsageSnapshot | null>>()
      .mockResolvedValueOnce(snapshot(10, 20, { fiveHour: now + 1_000, week: now + 2_000 }))
      .mockRejectedValue(new Error("offline"));

    cache.read("work", fetchSnapshot);
    await settle();
    now += 1_001;
    expect(cache.read("work", fetchSnapshot).freshness).toBe("loading");
    await settle();
    expect(cache.read("work", fetchSnapshot)).toEqual({
      freshness: "unavailable",
      fetchedAt: 2_000_000,
      windows: [],
      unavailableReason: "reset_elapsed",
    });

    const oldCache = createUsageCache(() => now);
    oldCache.read("old", async () => snapshot(10, 20));
    await settle();
    now += 10 * 60_000 + 1;
    expect(
      oldCache.read("old", async () => {
        throw new Error("offline");
      }).freshness,
    ).toBe("loading");
    await settle();
    expect(oldCache.read("old", async () => snapshot(1, 1)).unavailableReason).toBe(
      "stale_expired",
    );
  });

  it("rejects partial, duplicate, extra, and malformed window snapshots", async () => {
    const invalidSnapshots: ProviderUsageSnapshot[] = [
      { ...snapshot(1, 2), windows: [{ label: "5h", usedPercent: 1 }] },
      {
        ...snapshot(1, 2),
        windows: [
          { label: "5h", usedPercent: 1 },
          { label: "5h", usedPercent: 2 },
        ],
      },
      {
        ...snapshot(1, 2),
        windows: [
          { label: "5h", usedPercent: 1 },
          { label: "Week", usedPercent: 2 },
          { label: "Day", usedPercent: 3 },
        ],
      },
      snapshot(Number.NaN, 2),
    ];

    for (const [index, invalid] of invalidSnapshots.entries()) {
      const cache = createUsageCache(() => 1_000);
      cache.read(`profile-${index}`, async () => invalid);
      await settle();
      expect(cache.read(`profile-${index}`, async () => invalid).unavailableReason).toBe(
        "invalid_usage",
      );
    }
  });

  it("keeps opaque bindings separated and a changed binding selects another entry immediately", async () => {
    const cache = createUsageCache(() => 1_000);
    const workFetch = vi.fn(async () => snapshot(10, 20));
    const personalFetch = vi.fn(async () => snapshot(70, 80));
    cache.read("work", workFetch);
    cache.read("personal", personalFetch);
    await settle();

    expect(cache.read("work", workFetch).windows[0]?.remainingPercent).toBe(90);
    expect(cache.read("personal", personalFetch).windows[0]?.remainingPercent).toBe(30);
    expect(workFetch).toHaveBeenCalledOnce();
    expect(personalFetch).toHaveBeenCalledOnce();
  });

  it("never returns a cached native value after its revision changes", async () => {
    const cache = new ClawlineCodexUsageCache(() => 1_000);
    cache.read("revision-a", async () => ({
      bindingKey: "revision-a",
      snapshot: snapshot(10, 20),
    }));
    await settle();

    expect(
      cache.read(
        "revision-a",
        async () => ({ bindingKey: "revision-a", snapshot: snapshot(10, 20) }),
        () => false,
      ),
    ).toBeNull();
  });

  it("does not start a stale refresh after native revision validation fails", async () => {
    let now = 1_000;
    const cache = new ClawlineCodexUsageCache(() => now);
    const fetchSnapshot = vi.fn(async () => ({
      bindingKey: "revision-a",
      snapshot: snapshot(10, 20),
    }));
    cache.read("revision-a", fetchSnapshot);
    await settle();
    now += 60_001;

    expect(cache.read("revision-a", fetchSnapshot, () => false)).toBeNull();
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it("publishes a raced refresh only under the provider's newest binding key", async () => {
    const cache = new ClawlineCodexUsageCache(() => 1_000);
    cache.read("revision-a", async () => ({
      bindingKey: "revision-b",
      snapshot: snapshot(36, 72),
    }));
    await settle();

    expect(
      cache.read("revision-b", async () => ({ bindingKey: "revision-b", snapshot: null })),
    ).toMatchObject({
      freshness: "fresh",
      windows: [
        { label: "5h", remainingPercent: 64 },
        { label: "Week", remainingPercent: 28 },
      ],
    });
  });

  it("re-keys a null provider result and retains its retry floor", async () => {
    let now = 1_000;
    const cache = new ClawlineCodexUsageCache(() => now);
    const fetchSnapshot = vi
      .fn<() => Promise<{ bindingKey: string; snapshot: ProviderUsageSnapshot | null }>>()
      .mockResolvedValueOnce({ bindingKey: "revision-a", snapshot: snapshot(10, 20) })
      .mockResolvedValueOnce({ bindingKey: "revision-b", snapshot: null });
    cache.read("revision-a", fetchSnapshot);
    await settle();
    now += 60_001;
    cache.read("revision-a", fetchSnapshot);
    await settle();

    expect(
      cache.read("revision-b", async () => ({
        bindingKey: "revision-b",
        snapshot: snapshot(1, 1),
      })),
    ).toMatchObject({
      freshness: "unavailable",
      unavailableReason: "provider_unavailable",
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "invalid re-keyed snapshot",
      failure: () => ({
        bindingKey: "revision-b",
        snapshot: { ...snapshot(10, 20), windows: [] },
      }),
      nextKey: "revision-b",
      reason: "invalid_usage",
    },
    {
      name: "unreadable revision race",
      failure: () => {
        throw new ProviderUsageBindingError("account_binding_unavailable");
      },
      nextKey: "revision-a",
      reason: "account_binding_unavailable",
    },
  ])("clears stale usage after $name", async ({ failure, nextKey, reason }) => {
    let now = 1_000;
    const cache = new ClawlineCodexUsageCache(() => now);
    const fetchSnapshot = vi
      .fn<() => Promise<{ bindingKey: string; snapshot: ProviderUsageSnapshot | null }>>()
      .mockResolvedValueOnce({ bindingKey: "revision-a", snapshot: snapshot(10, 20) })
      .mockImplementationOnce(async () => failure());
    cache.read("revision-a", fetchSnapshot);
    await settle();
    now += 60_001;
    cache.read("revision-a", fetchSnapshot);
    await settle();

    expect(
      cache.read(nextKey, async () => ({ bindingKey: nextKey, snapshot: null })),
    ).toMatchObject({ freshness: "unavailable", unavailableReason: reason, windows: [] });
  });

  it("re-keys a raced refresh while all 32 binding slots are occupied", async () => {
    const cache = new ClawlineCodexUsageCache(() => 1_000);
    const never = new Promise<never>(() => undefined);
    for (let index = 0; index < 31; index += 1) {
      cache.read(`pending-${index}`, () => never);
    }
    cache.read("revision-a", async () => ({
      bindingKey: "revision-b",
      snapshot: snapshot(36, 72),
    }));
    await settle();

    expect(
      cache.read("revision-b", async () => ({ bindingKey: "revision-b", snapshot: null })),
    ).toMatchObject({ freshness: "fresh" });
  });

  it("re-keys repeated-race unavailable state onto the newest binding", async () => {
    let now = 1_000;
    const cache = new ClawlineCodexUsageCache(() => now);
    const fetchSnapshot = vi
      .fn<() => Promise<{ bindingKey: string; snapshot: ProviderUsageSnapshot | null }>>()
      .mockResolvedValueOnce({ bindingKey: "revision-a", snapshot: snapshot(10, 20) })
      .mockRejectedValueOnce(
        new ProviderUsageBindingError("account_binding_unavailable", undefined, "revision-c"),
      );
    cache.read("revision-a", fetchSnapshot);
    await settle();
    now += 60_001;
    cache.read("revision-a", fetchSnapshot);
    await settle();

    expect(
      cache.read("revision-c", async () => ({ bindingKey: "revision-c", snapshot: null })),
    ).toMatchObject({
      freshness: "unavailable",
      unavailableReason: "account_binding_unavailable",
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("bounds settled binding entries to the 32 least-recently used keys", async () => {
    const cache = createUsageCache(() => 1_000);
    const fetches = Array.from({ length: 33 }, (_, index) =>
      vi.fn(async () => snapshot(index, index)),
    );
    for (let index = 0; index < fetches.length; index += 1) {
      cache.read(`profile-${index}`, fetches[index]);
      await settle();
    }

    cache.read("profile-0", fetches[0]);
    expect(fetches[0]).toHaveBeenCalledTimes(2);
    cache.read("profile-32", fetches[32]);
    expect(fetches[32]).toHaveBeenCalledOnce();
  });

  it("maps only sanitized unavailable reasons", async () => {
    const cache = createUsageCache(() => 1_000);
    cache.read("binding", async () => {
      throw new ProviderUsageBindingError("account_binding_unavailable");
    });
    cache.read("timeout", async () => {
      throw new ProviderUsageBindingError("timeout");
    });
    await settle();

    expect(cache.read("binding", async () => null).unavailableReason).toBe(
      "account_binding_unavailable",
    );
    expect(cache.read("timeout", async () => null).unavailableReason).toBe("timeout");
    expect(JSON.stringify(cache.read("binding", async () => null))).not.toContain("profile");
  });

  it("returns loading when a no-sample retry starts after its failure floor", async () => {
    let now = 1_000;
    const cache = new ClawlineCodexUsageCache(() => now);
    const retry = new Promise<{ bindingKey: string; snapshot: ProviderUsageSnapshot | null }>(
      () => undefined,
    );
    const fetchSnapshot = vi
      .fn<() => Promise<{ bindingKey: string; snapshot: ProviderUsageSnapshot | null }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(retry);
    cache.read("binding", fetchSnapshot);
    await settle();
    now += 30_000;

    expect(cache.read("binding", fetchSnapshot)).toMatchObject({ freshness: "loading" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("retains timed-out work as the binding's single in-flight refresh", async () => {
    let now = 1_000;
    let settleUnderlying: (() => void) | undefined;
    const unsettledWork = new Promise<void>((resolve) => {
      settleUnderlying = resolve;
    });
    const cache = new ClawlineCodexUsageCache(() => now);
    const fetchSnapshot = vi.fn(async () => {
      throw new ProviderUsageBindingError("timeout", unsettledWork);
    });

    cache.read("binding", fetchSnapshot);
    await settle();
    expect(cache.read("binding", fetchSnapshot)).toMatchObject({
      freshness: "unavailable",
      unavailableReason: "timeout",
    });
    now += 60_000;
    cache.read("binding", fetchSnapshot);
    expect(fetchSnapshot).toHaveBeenCalledOnce();

    settleUnderlying?.();
    await settle();
  });
});
