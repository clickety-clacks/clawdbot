import type { OpenClawConfig } from "../config/config.js";
import {
  resolveStorePath,
  resolveMainSessionKey,
  resolveAgentIdFromSessionKey,
} from "../config/sessions.js";
import { resolveClawlineConfig } from "./config.js";
import { createProviderServer } from "./server.js";
import type { Logger, ProviderServer } from "./domain.js";
import { setClawlineOutboundSender } from "./outbound.js";

export type ClawlineServiceHandle = {
  stop: () => Promise<void>;
};

export async function startClawlineService(params: {
  config: OpenClawConfig;
  logger?: Logger;
}): Promise<ClawlineServiceHandle | null> {
  const logger = params.logger ?? console;
  const resolved = resolveClawlineConfig(params.config);
  if (!resolved.enabled) {
    logger.info?.("[clawline] service disabled in config");
    return null;
  }
  const randomizePort =
    Boolean(process.env.VITEST_WORKER_ID) && params.config.channels?.clawline?.port === undefined;
  const providerConfig = randomizePort ? { ...resolved, port: 0 } : resolved;
  const mainSessionKey = resolveMainSessionKey(params.config);
  const mainSessionAgentId = resolveAgentIdFromSessionKey(mainSessionKey);
  const sessionStorePath = resolveStorePath(params.config.session?.store, {
    agentId: mainSessionAgentId,
  });
  const server: ProviderServer = await createProviderServer({
    config: providerConfig,
    openClawConfig: params.config,
    logger,
    sessionStorePath,
    mainSessionKey,
  });
  await server.start();
  setClawlineOutboundSender((payload) => server.sendMessage(payload));
  logger.info?.(
    `[clawline] listening on ${providerConfig.network.bindAddress}:${server.getPort()}`,
  );
  return {
    stop: async () => {
      setClawlineOutboundSender(null);
      await server.stop();
    },
  };
}
