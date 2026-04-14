export declare function resolveRepoRelativeOutputDir(repoRoot: string, outputDir?: string): string | undefined;
export declare function assertRepoBoundPath(repoRoot: string, targetPath: string, label: string): Promise<string>;
export declare function ensureRepoBoundDirectory(repoRoot: string, targetDir: string, label: string, opts?: {
    mode?: number;
}): Promise<string>;
