export type SurfAceRuntime = {
  list(params: { userId: string | null }): Promise<unknown>;
  push(params: {
    userId: string | null;
    fingerprint: string;
    contentType: string;
    content: string;
  }): Promise<unknown>;
  clear(params: { userId: string | null; fingerprint: string }): Promise<unknown>;
  read(params: { userId: string | null; fingerprint: string }): Promise<unknown>;
  annotationsRemove(params: {
    userId: string | null;
    fingerprint: string;
    contentId: string;
    strokeIds: string[];
  }): Promise<unknown>;
};

let surfAceRuntime: SurfAceRuntime | null = null;

export function setClawlineSurfAceRuntime(runtime: SurfAceRuntime | null): void {
  surfAceRuntime = runtime;
}

export function hasClawlineSurfAceRuntime(): boolean {
  return Boolean(surfAceRuntime);
}

export function requireClawlineSurfAceRuntime(): SurfAceRuntime {
  if (!surfAceRuntime) {
    throw new Error("Surf Ace runtime is not available (Clawline provider is not running)");
  }
  return surfAceRuntime;
}
