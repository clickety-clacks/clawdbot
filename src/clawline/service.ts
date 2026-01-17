import type { ClawdbotConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions.js";
import { resolveClawlineConfig } from "./config.js";
import { createProviderServer } from "./server.js";
import type { Logger, ProviderServer } from "./domain.js";

export type ClawlineServiceHandle = {
  stop: () => Promise<void>;
};

export async function startClawlineService(params: {
  config: ClawdbotConfig;
  logger?: Logger;
}): Promise<ClawlineServiceHandle | null> {
  const logger = params.logger ?? console;
  const resolved = resolveClawlineConfig(params.config);
  if (!resolved.enabled) {
    logger.info?.("[clawline] service disabled in config");
    return null;
  }
  const sessionStorePath = resolveStorePath(params.config.session?.store);
  const server: ProviderServer = await createProviderServer({
    config: resolved,
    clawdbotConfig: params.config,
    logger,
    sessionStorePath,
  });
  await server.start();
  logger.info?.(
    `[clawline] listening on ${resolved.network.bindAddress}:${server.getPort()}`,
  );
  return {
    stop: async () => {
      await server.stop();
    },
  };
}
