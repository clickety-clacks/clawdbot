import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCodexCommand } from "./src/commands.js";

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server inspection and control commands.",
  register(api) {
    api.registerCommand(createCodexCommand({ pluginConfig: api.pluginConfig }));
  },
});
