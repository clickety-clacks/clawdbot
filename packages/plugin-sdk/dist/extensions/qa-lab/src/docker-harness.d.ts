export declare function writeQaDockerHarnessFiles(params: {
    outputDir: string;
    repoRoot: string;
    gatewayPort?: number;
    qaLabPort?: number;
    gatewayToken?: string;
    providerBaseUrl?: string;
    qaBusBaseUrl?: string;
    imageName?: string;
    usePrebuiltImage?: boolean;
    bindUiDist?: boolean;
    includeQaLabUi?: boolean;
}): Promise<{
    outputDir: string;
    imageName: string;
    files: string[];
}>;
export declare function buildQaDockerHarnessImage(params: {
    repoRoot: string;
    imageName?: string;
}, deps?: {
    runCommand?: (command: string, args: string[], cwd: string) => Promise<{
        stdout: string;
        stderr: string;
    }>;
}): Promise<{
    imageName: string;
}>;
