// Gateway runtime plugin config resolver.
// Applies plugin auto-enable rules against the active manifest snapshot.
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";

export function resolveGatewayPluginConfig(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): OpenClawConfig {
  const env = params.env ?? process.env;
  const currentSnapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env,
    allowWorkspaceScopedSnapshot: true,
  });
  return applyPluginAutoEnable({
    config: params.config,
    env,
    manifestRegistry: currentSnapshot?.manifestRegistry,
    discovery: currentSnapshot?.discovery,
  }).config;
}
