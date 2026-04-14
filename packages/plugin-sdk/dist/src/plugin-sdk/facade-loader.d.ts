type JitiLoader = ReturnType<(typeof import("jiti"))["createJiti"]>;
export declare function createLazyFacadeObjectValue<T extends object>(load: () => T): T;
export declare function createLazyFacadeArrayValue<T extends readonly unknown[]>(load: () => T): T;
export type FacadeModuleLocation = {
    modulePath: string;
    boundaryRoot: string;
};
export declare function loadFacadeModuleAtLocationSync<T extends object>(params: {
    location: FacadeModuleLocation;
    trackedPluginId: string | (() => string);
    loadModule?: (modulePath: string) => T;
}): T;
export declare function loadBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
    dirName: string;
    artifactBasename: string;
    trackedPluginId?: string | (() => string);
}): T;
export declare function listImportedBundledPluginFacadeIds(): string[];
export declare function resetFacadeLoaderStateForTest(): void;
export declare function setFacadeLoaderJitiFactoryForTest(factory: ((...args: Parameters<(typeof import("jiti"))["createJiti"]>) => JitiLoader) | undefined): void;
export {};
