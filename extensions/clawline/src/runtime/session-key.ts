export function clawlineSessionFileName(sessionKey: string): string {
  return sessionKey.replace(/[^a-z0-9_-]/gi, "-");
}
