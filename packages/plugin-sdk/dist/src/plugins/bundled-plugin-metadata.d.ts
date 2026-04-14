import { type OpenClawPackageManifest, type PluginManifest } from "./manifest.js";
type BundledPluginPathPair = {
    source: string;
    built: string;
};
export type BundledPluginMetadata = {
    dirName: string;
    idHint: string;
    source: BundledPluginPathPair;
    setupSource?: BundledPluginPathPair;
    publicSurfaceArtifacts?: readonly string[];
    runtimeSidecarArtifacts?: readonly string[];
    packageName?: string;
    packageVersion?: string;
    packageDescription?: string;
    packageManifest?: OpenClawPackageManifest;
    manifest: PluginManifest;
};
export declare function clearBundledPluginMetadataCache(): void;
export declare function listBundledPluginMetadata(params?: {
    rootDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
}): readonly BundledPluginMetadata[];
export declare function findBundledPluginMetadataById(pluginId: string, params?: {
    rootDir?: string;
}): BundledPluginMetadata | undefined;
export declare function resolveBundledPluginWorkspaceSourcePath(params: {
    rootDir: string;
    pluginId: string;
}): string | null;
export declare function resolveBundledPluginGeneratedPath(rootDir: string, entry: BundledPluginPathPair | undefined, pluginDirName?: string): string | null;
export declare function resolveBundledPluginRepoEntryPath(params: {
    rootDir: string;
    pluginId: string;
    preferBuilt?: boolean;
}): string | null;
export {};
