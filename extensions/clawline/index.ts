import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { startClawlineService, type ClawlineServiceHandle } from "clawdbot/plugin-sdk";
import { clawlinePlugin } from "./src/channel.js";

let serviceHandle: ClawlineServiceHandle | null = null;

const plugin = {
  id: "clawline",
  name: "Clawline",
  description: "Clawline channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: clawlinePlugin });
    api.registerService({
      id: "clawline",
      start: async ({ config, logger }) => {
        if (process.env.CLAWDBOT_SKIP_CLAWLINE === "1") {
          logger.info?.("skipping clawline service start (CLAWDBOT_SKIP_CLAWLINE=1)");
          return;
        }
        if (serviceHandle) return;
        try {
          serviceHandle = await startClawlineService({ config, logger });
        } catch (err) {
          logger.error?.(`clawline service failed to start: ${String(err)}`);
          serviceHandle = null;
        }
      },
      stop: async () => {
        if (!serviceHandle) return;
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
