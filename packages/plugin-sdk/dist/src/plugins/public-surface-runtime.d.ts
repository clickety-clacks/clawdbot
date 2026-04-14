export declare function normalizeBundledPluginArtifactSubpath(artifactBasename: string): string;
export declare function resolveBundledPluginPublicSurfacePath(params: {
    rootDir: string;
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
    bundledPluginsDir?: string;
}): string | null;
