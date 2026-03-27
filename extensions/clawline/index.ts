import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { clawlinePlugin } from "./src/channel.js";
import { startClawlineService } from "./src/runtime/service.js";

let serviceHandle: Awaited<ReturnType<typeof startClawlineService>> = null;
let serviceStart: Promise<void> | null = null;

export default defineChannelPluginEntry({
  id: "clawline",
  name: "Clawline",
  description: "Clawline channel plugin",
  plugin: clawlinePlugin,
  registerFull(api) {
    api.registerService({
      id: "clawline",
      start: async ({ config, logger }) => {
        if (process.env.CLAWDBOT_SKIP_CLAWLINE === "1") {
          logger.info?.("skipping clawline service start (CLAWDBOT_SKIP_CLAWLINE=1)");
          return;
        }
        if (config.channels?.clawline?.enabled !== true) {
          logger.info?.("skipping clawline service start (clawline disabled in config)");
          return;
        }
        if (serviceHandle || serviceStart) {
          return;
        }
        serviceStart = (async () => {
          try {
            serviceHandle = await startClawlineService({ config, logger });
          } catch (err) {
            logger.error?.(`clawline service failed to start: ${String(err)}`);
            serviceHandle = null;
          } finally {
            serviceStart = null;
          }
        })();
        await serviceStart;
      },
      stop: async () => {
        if (!serviceHandle) {
          return;
        }
        try {
          await serviceHandle.stop();
        } finally {
          serviceHandle = null;
        }
      },
    });
  },
});
