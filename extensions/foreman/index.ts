import { registerForemanPluginRuntime } from "openclaw/plugin-sdk/foreman-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const plugin = {
  id: "foreman",
  name: "Foreman",
  description: "Managed TaskFlow bridge for tmux-backed coding agents.",
  register(api: OpenClawPluginApi) {
    registerForemanPluginRuntime(api);
  },
};

export default plugin;
