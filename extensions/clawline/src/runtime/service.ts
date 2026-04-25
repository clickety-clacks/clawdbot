import {
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  type OpenClawConfig,
} from "../runtime-api.js";
import { resolveClawlineConfig } from "./config.js";
import type { Logger, ProviderServer } from "./domain.js";
import { createClawlineOutboundSenderOwnerToken, setClawlineOutboundSender } from "./outbound.js";
import { createProviderServer } from "./server.js";
import { resolveClawlineMainSessionKey } from "./session-compat.js";

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
  const mainSessionKey = resolveClawlineMainSessionKey(params.config);
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
  const ownerToken = createClawlineOutboundSenderOwnerToken();
  await server.start();
  setClawlineOutboundSender((payload) => server.sendMessage(payload), ownerToken);
  logger.info?.(
    `[clawline] listening on ${providerConfig.network.bindAddress}:${server.getPort()}`,
  );
  return {
    stop: async () => {
      setClawlineOutboundSender(null, ownerToken);
      await server.stop();
    },
  };
}
