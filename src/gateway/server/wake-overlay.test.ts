import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyWakeOverlay } from "./wake-overlay.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("applyWakeOverlay", () => {
  test("keeps base text when wakeOverlayPath is unset", async () => {
    const warn = vi.fn();
    await expect(
      applyWakeOverlay({
        baseText: "Ping",
        maxBytes: 1024,
        logHooks: { warn },
      }),
    ).resolves.toBe("Ping");
    expect(warn).not.toHaveBeenCalled();
  });

  test("appends non-empty overlay text with a blank line separator", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wake-overlay-"));
    tmpDirs.push(dir);
    const overlayPath = path.join(dir, "wake-overlay.txt");
    await fs.writeFile(overlayPath, "Overlay line\n", "utf8");

    await expect(
      applyWakeOverlay({
        baseText: "Ping",
        wakeOverlayPath: overlayPath,
        maxBytes: 1024,
        logHooks: { warn: vi.fn() },
      }),
    ).resolves.toBe("Ping\n\nOverlay line");
  });

  test("ignores missing and whitespace-only overlay files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wake-overlay-"));
    tmpDirs.push(dir);
    const missingOverlayPath = path.join(dir, "missing.txt");
    const blankOverlayPath = path.join(dir, "blank.txt");
    await fs.writeFile(blankOverlayPath, "  \n\t\n", "utf8");

    await expect(
      applyWakeOverlay({
        baseText: "Ping",
        wakeOverlayPath: missingOverlayPath,
        maxBytes: 1024,
        logHooks: { warn: vi.fn() },
      }),
    ).resolves.toBe("Ping");

    await expect(
      applyWakeOverlay({
        baseText: "Ping",
        wakeOverlayPath: blankOverlayPath,
        maxBytes: 1024,
        logHooks: { warn: vi.fn() },
      }),
    ).resolves.toBe("Ping");
  });

  test("skips overlay and logs warning when combined text would exceed max bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wake-overlay-"));
    tmpDirs.push(dir);
    const overlayPath = path.join(dir, "wake-overlay.txt");
    await fs.writeFile(overlayPath, "1234567890", "utf8");
    const warn = vi.fn();

    await expect(
      applyWakeOverlay({
        baseText: "abcde",
        wakeOverlayPath: overlayPath,
        maxBytes: 12,
        logHooks: { warn },
      }),
    ).resolves.toBe("abcde");

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown> | undefined];
    expect(message).toContain("overlay skipped");
    expect(meta?.maxBytes).toBe(12);
  });
});
