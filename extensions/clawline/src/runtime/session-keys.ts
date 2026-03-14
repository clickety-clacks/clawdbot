export function resolveSubscribedSessionKeys(params: {
  sessionKey?: string;
  sessionKeys?: ReadonlyArray<string | null | undefined>;
}): string[] {
  const keys = (params.sessionKeys ?? []).filter(
    (key): key is string => typeof key === "string" && key.trim().length > 0,
  );
  if (keys.length > 0) {
    return keys;
  }
  return typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0
    ? [params.sessionKey]
    : [];
}
