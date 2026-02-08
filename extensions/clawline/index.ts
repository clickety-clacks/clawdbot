import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema, startClawlineService } from "openclaw/plugin-sdk";
import { clawlinePlugin } from "./src/channel.js";

let serviceHandle: Awaited<ReturnType<typeof startClawlineService>> = null;
let serviceStart: Promise<void> | null = null;

const plugin = {
  id: "clawline",
  name: "Clawline",
  description: "Clawline channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: clawlinePlugin });
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
};

export default plugin;
