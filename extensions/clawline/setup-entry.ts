import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { clawlinePlugin } from "./src/channel.js";

export default defineSetupPluginEntry(clawlinePlugin);
