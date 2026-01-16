import path from "node:path";

import { startClawlineService } from "../src/clawline/service.ts";
import type { ClawdbotConfig } from "../src/config/config.ts";

const workspaceDir = path.join(process.cwd(), "scratch", "workspace-test");

const cfg: ClawdbotConfig = {
  agents: {
    defaults: {
      workspace: workspaceDir,
      model: {
        primary: "anthropic/claude-3-sonnet",
      },
      timeoutSeconds: 300,
    },
  },
  clawline: {
    network: {
      bindAddress: "127.0.0.1",
      allowInsecurePublic: true,
      allowedOrigins: ["http://localhost"],
    },
    enabled: true,
  },
  session: {
    store: undefined,
  },
};

async function run() {
  console.log("starting first service");
  const service = await startClawlineService({ config: cfg, logger: console });
  if (!service) throw new Error("service disabled");
  console.log("first service started");
  await service.stop();
  console.log("first service stopped");
  console.log("starting second service");
  const service2 = await startClawlineService({ config: cfg, logger: console });
  if (!service2) throw new Error("service disabled");
  console.log("second service started");
  await service2.stop();
  console.log("second service stopped");
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
