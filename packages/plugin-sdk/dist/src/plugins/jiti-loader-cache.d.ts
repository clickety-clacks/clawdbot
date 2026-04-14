import { createJiti } from "jiti";
export type PluginJitiLoaderCache = Map<string, ReturnType<typeof createJiti>>;
export declare function getCachedPluginJitiLoader(params: {
    cache: PluginJitiLoaderCache;
    modulePath: string;
    importerUrl: string;
    argvEntry?: string;
}): ReturnType<typeof createJiti>;
