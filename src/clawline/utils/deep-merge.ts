export function deepMerge<T>(target: T, source: Partial<T>): T {
  const targetObj = target as unknown as Record<string, unknown>;
  for (const [rawKey, value] of Object.entries(source ?? {})) {
    if (rawKey === "__proto__" || rawKey === "constructor" || rawKey === "prototype") {
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof targetObj[rawKey] === "object" &&
      targetObj[rawKey] !== null &&
      !Array.isArray(targetObj[rawKey])
    ) {
      targetObj[rawKey] = deepMerge({ ...(targetObj[rawKey] as Record<string, unknown>) }, value);
    } else if (value !== undefined) {
      targetObj[rawKey] = value as unknown;
    }
  }
  return target;
}
