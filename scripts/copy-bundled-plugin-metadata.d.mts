export function rewritePackageExtensions(entries: unknown): string[] | undefined;

export function verifyBundledPluginManifestOutputs(params?: {
  repoRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string[];

export function copyBundledPluginMetadata(params?: {
  repoRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void;
