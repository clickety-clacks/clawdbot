import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { helmPlugin } from "./src/channel.js";

const plugin = {
  id: "helm",
  name: "Helm",
  description: "Helm visionOS visualization channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: helmPlugin });
  },
};

export default plugin;
