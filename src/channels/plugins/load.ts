import type { PluginRegistry } from "../../plugins/registry.js";
import type { ChannelId, ChannelPlugin } from "./types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";

type CorePluginLoader = () => Promise<ChannelPlugin>;

const CORE_LOADERS: Record<string, CorePluginLoader> = {
  clawline: async () => (await import("./clawline.js")).clawlinePlugin,
};

const cache = new Map<ChannelId, ChannelPlugin>();
let lastRegistry: PluginRegistry | null = null;

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
  const loader = CORE_LOADERS[id];
  if (loader) {
    const plugin = await loader();
    cache.set(id, plugin);
    return plugin;
  }
  return undefined;
}
