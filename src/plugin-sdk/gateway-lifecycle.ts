import { runDaemonRestart, runDaemonStop } from "../cli/daemon-cli/lifecycle.js";
import { gatherDaemonStatus, type DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import type { PortUsageStatus } from "../infra/ports-types.js";

function gatewayStopConfirmed(status: DaemonStatus): boolean {
  if (status.rpc?.ok === true) {
    return false;
  }
  const portStatuses = [status.port?.status, status.portCli?.status].filter(
    (portStatus): portStatus is PortUsageStatus => typeof portStatus === "string",
  );
  if (portStatuses.some((portStatus) => portStatus === "busy")) {
    return false;
  }
  const runtimeStatus = status.service.runtime?.status;
  const runtimeState = status.service.runtime?.state;
  if (runtimeStatus || runtimeState) {
    return runtimeStatus === "stopped" || runtimeState === "not-loaded";
  }
  if (portStatuses.length > 0 && portStatuses.every((portStatus) => portStatus === "free")) {
    return true;
  }
  return false;
}

export async function restartGatewayServiceAfterChannelConfigWrite(): Promise<boolean> {
  return await runDaemonRestart({ json: true, silent: true });
}

export async function stopGatewayServiceBeforeChannelConfigDelete(): Promise<boolean> {
  await runDaemonStop({ json: true, silent: true });
  const status = await gatherDaemonStatus({
    rpc: {},
    probe: true,
    requireRpc: false,
    deep: false,
  });
  return gatewayStopConfirmed(status);
}
