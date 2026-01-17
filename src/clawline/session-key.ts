const KEY_PART_REGEX = /[^a-z0-9_-]+/g;

function normalizeKeyPart(value: string): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  const slug = trimmed.replace(KEY_PART_REGEX, "-").replace(/^-+/, "").replace(/-+$/, "");
  return slug || "unknown";
}

export function buildClawlineSessionKey(userId: string): string {
  return `clawline:${normalizeKeyPart(userId)}:personal`;
}

export function clawlineSessionFileName(sessionKey: string): string {
  return sessionKey.replace(/[^a-z0-9_-]/gi, "-");
}
