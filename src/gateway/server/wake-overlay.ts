import fs from "node:fs/promises";
import type { SubsystemLogger } from "../../logging/subsystem.js";

type WakeOverlayLogger = Pick<SubsystemLogger, "warn">;

function isEnoentError(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return code === "ENOENT";
}

export async function applyWakeOverlay(params: {
  baseText: string;
  wakeOverlayPath?: string;
  maxBytes: number;
  logHooks: WakeOverlayLogger;
}): Promise<string> {
  const wakeOverlayPath = params.wakeOverlayPath?.trim();
  if (!wakeOverlayPath) {
    return params.baseText;
  }

  let rawOverlay: string;
  try {
    rawOverlay = await fs.readFile(wakeOverlayPath, "utf8");
  } catch (err) {
    if (!isEnoentError(err)) {
      params.logHooks.warn("hook wake overlay read failed; continuing without overlay", {
        wakeOverlayPath,
        error: String(err),
      });
    }
    return params.baseText;
  }

  const overlayText = rawOverlay.trim();
  if (!overlayText) {
    return params.baseText;
  }

  const combined = `${params.baseText}\n\n${overlayText}`;
  if (Buffer.byteLength(combined, "utf8") > params.maxBytes) {
    params.logHooks.warn("hook wake overlay skipped; combined text exceeds hooks.maxBodyBytes", {
      wakeOverlayPath,
      maxBytes: params.maxBytes,
      baseTextBytes: Buffer.byteLength(params.baseText, "utf8"),
      overlayBytes: Buffer.byteLength(overlayText, "utf8"),
    });
    return params.baseText;
  }

  return combined;
}
