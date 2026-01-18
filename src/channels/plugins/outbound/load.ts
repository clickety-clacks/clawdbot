import type { PluginRegistry } from "../../../plugins/registry.js";
import type { ChannelId, ChannelOutboundAdapter } from "../types.js";
import { getActivePluginRegistry } from "../../../plugins/runtime.js";

type CoreOutboundLoader = () => Promise<ChannelOutboundAdapter>;

const CORE_LOADERS: Record<string, CoreOutboundLoader> = {
  clawline: async () => (await import("./clawline.js")).clawlineOutbound,
};

// Channel docking: outbound sends should stay cheap to import.
//
// The full channel plugins (src/channels/plugins/*.ts) pull in status,
// onboarding, gateway monitors, etc. Outbound delivery only needs chunking +
// send primitives, so we keep a dedicated, lightweight loader here.
const LOADERS: Record<ChatChannelId, OutboundLoader> = {
  telegram: async () => (await import("./telegram.js")).telegramOutbound,
  whatsapp: async () => (await import("./whatsapp.js")).whatsappOutbound,
  discord: async () => (await import("./discord.js")).discordOutbound,
  slack: async () => (await import("./slack.js")).slackOutbound,
  signal: async () => (await import("./signal.js")).signalOutbound,
  imessage: async () => (await import("./imessage.js")).imessageOutbound,
  msteams: async () => (await import("./msteams.js")).msteamsOutbound,
  clawline: async () => (await import("./clawline.js")).clawlineOutbound,
};

const cache = new Map<ChannelId, ChannelOutboundAdapter>();
let lastRegistry: PluginRegistry | null = null;

function ensureCacheForRegistry(registry: PluginRegistry | null) {
  if (registry === lastRegistry) {
    return;
  }
  cache.clear();
  lastRegistry = registry;
}

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  const registry = getActivePluginRegistry();
  ensureCacheForRegistry(registry);
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  const outbound = pluginEntry?.plugin.outbound;
  if (outbound) {
    cache.set(id, outbound);
    return outbound;
  }
  const loader = CORE_LOADERS[id];
  if (loader) {
    const loaded = await loader();
    cache.set(id, loaded);
    return loaded;
  }
  return undefined;
}
