import type { ChannelId, ChannelOutboundAdapter } from "../types.js";
import type { PluginRegistry } from "../../../plugins/registry.js";
import { getActivePluginRegistry } from "../../../plugins/runtime.js";
import { clawlineOutbound } from "./outbound/clawline.js";

// Channel docking: outbound sends should stay cheap to import.
//
// The full channel plugins (src/channels/plugins/*.ts) pull in status,
// onboarding, gateway monitors, etc. Outbound delivery only needs chunking +
// send primitives, so we keep a dedicated, lightweight loader here.
const cache = new Map<ChannelId, ChannelOutboundAdapter>();
let lastRegistry: PluginRegistry | null = null;
const CORE_OUTBOUND = new Map<ChannelId, ChannelOutboundAdapter>([
  ["clawline", clawlineOutbound],
]);

function ensureCacheForRegistry(registry: PluginRegistry | null) {
  if (registry === lastRegistry) return;
  cache.clear();
  lastRegistry = registry;
}

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  const registry = getActivePluginRegistry();
  ensureCacheForRegistry(registry);
  const cached = cache.get(id);
  if (cached) return cached;
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  const outbound = pluginEntry?.plugin.outbound;
  if (outbound) {
    cache.set(id, outbound);
    return outbound;
  }
  const coreOutbound = CORE_OUTBOUND.get(id);
  if (coreOutbound) {
    cache.set(id, coreOutbound);
    return coreOutbound;
  }
  return undefined;
}
