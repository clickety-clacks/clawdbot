import type { SurfAceRuntime } from "./surf-ace.js";

const GLOBAL_KEY = "__openclaw_surf_ace_runtime";

type SurfAceRuntimeGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: SurfAceRuntime | null;
};

function runtimeGlobal(): SurfAceRuntimeGlobal {
  return globalThis as SurfAceRuntimeGlobal;
}

export function setClawlineSurfAceRuntime(runtime: SurfAceRuntime | null): void {
  runtimeGlobal()[GLOBAL_KEY] = runtime;
}

export function hasClawlineSurfAceRuntime(): boolean {
  return Boolean(runtimeGlobal()[GLOBAL_KEY]);
}

export function requireClawlineSurfAceRuntime(): SurfAceRuntime {
  const runtime = runtimeGlobal()[GLOBAL_KEY];
  if (!runtime) {
    throw new Error("Surf Ace runtime is not available (Clawline provider is not running)");
  }
  return runtime;
}
