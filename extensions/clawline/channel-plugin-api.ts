// Keep the bundled Clawline entry on a top-level dist seam so packaged loads
// cannot fall back into source and split runtime singleton state.
export { clawlinePlugin } from "./api.js";
