export function deepMerge<T>(target: T, source: Partial<T>): T {
  for (const [rawKey, value] of Object.entries(source ?? {}) as [keyof T, any][]) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (target as any)[rawKey] === "object" &&
      (target as any)[rawKey] !== null &&
      !Array.isArray((target as any)[rawKey])
    ) {
      (target as any)[rawKey] = deepMerge(
        { ...(target as any)[rawKey] } as Record<string, unknown>,
        value,
      );
    } else if (value !== undefined) {
      (target as any)[rawKey] = value;
    }
  }
  return target;
}
