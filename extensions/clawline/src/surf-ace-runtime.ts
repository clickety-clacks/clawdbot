export type SurfAceSourceRef = {
  sessionKey: string;
  messageId: string;
};

export type SurfAceWatchDebounce = Partial<{
  scroll_settle: number;
  zoom_settle: number;
  text_selected: number;
  point: number;
  region: number;
  page_change: number;
}>;

export type SurfAceRuntime = {
  register(params: { userId: string | null; url: string }): Promise<unknown>;
  pair(params: { userId: string | null; screen: string }): Promise<unknown>;
  push(params: {
    userId: string | null;
    screen: string;
    contentType: string;
    content: Record<string, unknown>;
    title?: string;
    sourceRef?: SurfAceSourceRef;
    frameId?: string;
  }): Promise<unknown>;
  watch(params: {
    userId: string | null;
    screen: string;
    enabled: boolean;
    debounce?: SurfAceWatchDebounce;
    watcherSessionKey?: string;
  }): Promise<unknown>;
  clear(params: { userId: string | null; screen: string }): Promise<unknown>;
  snapshot(params: { userId: string | null; screen?: string }): Promise<unknown>;
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
