import {
  ProviderUsageBindingError,
  type ProviderUsageFetchResult,
  type ProviderUsageSnapshot,
} from "../runtime-api.js";

const FRESH_TTL_MS = 60_000;
const STALE_RETENTION_MS = 10 * 60_000;
const FAILED_REFRESH_RETRY_MS = 30_000;
const MAX_BINDING_ENTRIES = 32;

export type ClawlineCodexUsageUnavailableReason =
  | "account_binding_unavailable"
  | "provider_unavailable"
  | "timeout"
  | "invalid_usage"
  | "stale_expired"
  | "reset_elapsed";

export type ClawlineCodexUsageWindow = {
  label: "5h" | "Week";
  remainingPercent: number;
  resetAt: number | null;
};

export type ClawlineCodexUsage = {
  freshness: "loading" | "fresh" | "stale" | "unavailable";
  fetchedAt: number | null;
  windows: ClawlineCodexUsageWindow[];
  unavailableReason: ClawlineCodexUsageUnavailableReason | null;
};

type UsageSample = {
  fetchedAt: number;
  windows: ClawlineCodexUsageWindow[];
};

type UsageCacheEntry = {
  sample?: UsageSample;
  inFlight?: Promise<void>;
  retryAt?: number;
  failureReason?: ClawlineCodexUsageUnavailableReason;
};

class InvalidUsageError extends Error {}

export class ClawlineCodexUsageCache {
  private readonly entries = new Map<string, UsageCacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  read(
    bindingKey: string,
    fetchSnapshot: () => Promise<ProviderUsageFetchResult>,
    isCurrent?: () => boolean,
  ): ClawlineCodexUsage | null {
    const entry = this.getOrCreateEntry(bindingKey);
    if (!entry) {
      return unavailableUsage("provider_unavailable", null);
    }
    const now = this.now();
    const sample = entry.sample;
    if (!sample) {
      const refreshing = this.startRefresh(bindingKey, entry, fetchSnapshot, now);
      if (refreshing) {
        return loadingUsage();
      }
      if (entry.failureReason) {
        return unavailableUsage(entry.failureReason, null);
      }
      if (entry.inFlight) {
        return loadingUsage();
      }
      return unavailableUsage(entry.failureReason ?? "provider_unavailable", null);
    }

    const resetElapsed = sample.windows.some(
      (window) => window.resetAt !== null && window.resetAt <= now,
    );
    if (resetElapsed) {
      if (isCurrent && !isCurrent()) {
        return null;
      }
      const refreshing = this.startRefresh(bindingKey, entry, fetchSnapshot, now);
      const usage =
        refreshing || entry.inFlight
          ? loadingUsage()
          : unavailableUsage("reset_elapsed", sample.fetchedAt);
      return usage;
    }

    const age = now - sample.fetchedAt;
    if (age <= FRESH_TTL_MS) {
      const usage = availableUsage("fresh", sample);
      return isCurrent && !isCurrent() ? null : usage;
    }
    if (age <= STALE_RETENTION_MS) {
      if (isCurrent && !isCurrent()) {
        return null;
      }
      this.startRefresh(bindingKey, entry, fetchSnapshot, now);
      return availableUsage("stale", sample);
    }

    if (isCurrent && !isCurrent()) {
      return null;
    }
    const refreshing = this.startRefresh(bindingKey, entry, fetchSnapshot, now);
    const usage =
      refreshing || entry.inFlight
        ? loadingUsage()
        : unavailableUsage("stale_expired", sample.fetchedAt);
    return usage;
  }

  private getOrCreateEntry(bindingKey: string): UsageCacheEntry | null {
    const existing = this.entries.get(bindingKey);
    if (existing) {
      this.entries.delete(bindingKey);
      this.entries.set(bindingKey, existing);
      return existing;
    }
    this.evictSettledEntries();
    if (this.entries.size >= MAX_BINDING_ENTRIES) {
      const settled = [...this.entries].find(([, candidate]) => !candidate.inFlight);
      if (settled) {
        this.entries.delete(settled[0]);
      }
    }
    if (this.entries.size >= MAX_BINDING_ENTRIES) {
      return null;
    }
    const entry: UsageCacheEntry = {};
    this.entries.set(bindingKey, entry);
    return entry;
  }

  private startRefresh(
    bindingKey: string,
    entry: UsageCacheEntry,
    fetchSnapshot: () => Promise<ProviderUsageFetchResult>,
    now: number,
  ): boolean {
    if (entry.inFlight || (entry.retryAt !== undefined && now < entry.retryAt)) {
      return false;
    }
    entry.inFlight = fetchSnapshot()
      .then((result) => {
        const target = this.rekeyEntry(bindingKey, result.bindingKey, entry);
        if (!result.snapshot) {
          target.failureReason = "provider_unavailable";
          target.retryAt = this.now() + FAILED_REFRESH_RETRY_MS;
          return;
        }
        target.sample = {
          fetchedAt: this.now(),
          windows: normalizeUsageWindows(result.snapshot),
        };
        target.retryAt = undefined;
        target.failureReason = undefined;
      })
      .catch((error: unknown) => {
        const target =
          error instanceof ProviderUsageBindingError && error.bindingKey
            ? this.rekeyEntry(bindingKey, error.bindingKey, entry)
            : entry;
        if (
          error instanceof ProviderUsageBindingError &&
          error.code === "account_binding_unavailable"
        ) {
          target.sample = undefined;
        }
        target.failureReason = classifyUsageFailure(error);
        target.retryAt = this.now() + FAILED_REFRESH_RETRY_MS;
        if (error instanceof ProviderUsageBindingError && error.unsettledWork) {
          return error.unsettledWork;
        }
        return undefined;
      })
      .finally(() => {
        entry.inFlight = undefined;
        this.evictSettledEntries();
      });
    return true;
  }

  private rekeyEntry(currentKey: string, nextKey: string, entry: UsageCacheEntry): UsageCacheEntry {
    if (nextKey === currentKey) {
      return entry;
    }
    entry.sample = undefined;
    const currentTarget = this.entries.get(nextKey);
    if (this.entries.get(currentKey) === entry) {
      this.entries.delete(currentKey);
    }
    if (currentTarget) {
      currentTarget.sample = undefined;
      return currentTarget;
    }
    this.entries.set(nextKey, entry);
    return entry;
  }

  private evictSettledEntries(): void {
    while (this.entries.size > MAX_BINDING_ENTRIES) {
      const settled = [...this.entries].find(([, entry]) => !entry.inFlight);
      if (!settled) {
        return;
      }
      this.entries.delete(settled[0]);
    }
  }
}

export function unavailableCodexUsage(
  reason: ClawlineCodexUsageUnavailableReason,
  fetchedAt: number | null = null,
): ClawlineCodexUsage {
  return unavailableUsage(reason, fetchedAt);
}

function normalizeUsageWindows(snapshot: ProviderUsageSnapshot): ClawlineCodexUsageWindow[] {
  if (snapshot.windows.length !== 2) {
    throw new InvalidUsageError();
  }
  const fiveHour = snapshot.windows.filter((window) => window.label === "5h");
  const week = snapshot.windows.filter((window) => window.label === "Week");
  if (fiveHour.length !== 1 || week.length !== 1) {
    throw new InvalidUsageError();
  }
  return [fiveHour[0], week[0]].map((window) => {
    if (!Number.isFinite(window.usedPercent)) {
      throw new InvalidUsageError();
    }
    const resetAt = window.resetAt;
    if (resetAt !== undefined && !Number.isFinite(resetAt)) {
      throw new InvalidUsageError();
    }
    return {
      label: window.label as "5h" | "Week",
      remainingPercent: Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))),
      resetAt: resetAt ?? null,
    };
  });
}

function classifyUsageFailure(error: unknown): ClawlineCodexUsageUnavailableReason {
  if (error instanceof InvalidUsageError) {
    return "invalid_usage";
  }
  if (error instanceof ProviderUsageBindingError) {
    return error.code;
  }
  return "provider_unavailable";
}

function loadingUsage(): ClawlineCodexUsage {
  return { freshness: "loading", fetchedAt: null, windows: [], unavailableReason: null };
}

function availableUsage(freshness: "fresh" | "stale", sample: UsageSample): ClawlineCodexUsage {
  return {
    freshness,
    fetchedAt: sample.fetchedAt,
    windows: sample.windows,
    unavailableReason: null,
  };
}

function unavailableUsage(
  unavailableReason: ClawlineCodexUsageUnavailableReason,
  fetchedAt: number | null,
): ClawlineCodexUsage {
  return { freshness: "unavailable", fetchedAt, windows: [], unavailableReason };
}
