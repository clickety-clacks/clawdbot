// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Clawline runtime/service surface.
export { clawlineSetupPlugin } from "./src/channel.setup.js";
