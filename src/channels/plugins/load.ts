import type { PluginRegistry } from "../../plugins/registry.js";
import type { ChannelId, ChannelPlugin } from "./types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { clawlinePlugin } from "./clawline.js";

type PluginLoader = () => Promise<ChannelPlugin>;

// Channel docking: load *one* plugin on-demand.
//
// This avoids importing `src/channels/plugins/index.ts` (intentionally heavy)
// from shared flows like outbound delivery / followup routing.
const LOADERS: Record<ChatChannelId, PluginLoader> = {
  telegram: async () => (await import("./telegram.js")).telegramPlugin,
  whatsapp: async () => (await import("./whatsapp.js")).whatsappPlugin,
  discord: async () => (await import("./discord.js")).discordPlugin,
  slack: async () => (await import("./slack.js")).slackPlugin,
  signal: async () => (await import("./signal.js")).signalPlugin,
  imessage: async () => (await import("./imessage.js")).imessagePlugin,
  msteams: async () => (await import("./msteams.js")).msteamsPlugin,
  clawline: async () => (await import("./clawline.js")).clawlinePlugin,
};

const cache = new Map<ChannelId, ChannelPlugin>();
let lastRegistry: PluginRegistry | null = null;
const CORE_CHANNEL_PLUGINS = new Map<ChannelId, ChannelPlugin>([
  ["clawline", clawlinePlugin],
]);

function ensureCacheForRegistry(registry: PluginRegistry | null) {
  if (registry === lastRegistry) {
    return;
  }
  cache.clear();
  lastRegistry = registry;
}

export async function loadChannelPlugin(id: ChannelId): Promise<ChannelPlugin | undefined> {
  const registry = getActivePluginRegistry();
  ensureCacheForRegistry(registry);
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  if (pluginEntry) {
    cache.set(id, pluginEntry.plugin);
    return pluginEntry.plugin;
  }
  const corePlugin = CORE_CHANNEL_PLUGINS.get(id);
  if (corePlugin) {
    cache.set(id, corePlugin);
    return corePlugin;
  }
  return undefined;
}
