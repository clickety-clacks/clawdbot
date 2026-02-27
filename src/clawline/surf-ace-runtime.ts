import type { SurfAceRuntime } from "./surf-ace.js";

let currentRuntime: SurfAceRuntime | null = null;

export function setClawlineSurfAceRuntime(runtime: SurfAceRuntime | null): void {
  currentRuntime = runtime;
}

export function hasClawlineSurfAceRuntime(): boolean {
  return currentRuntime !== null;
}

export function requireClawlineSurfAceRuntime(): SurfAceRuntime {
  if (!currentRuntime) {
    throw new Error("Surf Ace runtime is not available (Clawline provider is not running)");
  }
  return currentRuntime;
}
