import type { ClawlineOutboundSendParams, ClawlineOutboundSendResult } from "./domain.js";

type ClawlineSendFn = (params: ClawlineOutboundSendParams) => Promise<ClawlineOutboundSendResult>;

type ClawlineOutboundBridgeState = {
  currentSender: ClawlineSendFn | null;
};

const CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY = Symbol.for("openclaw.clawline.outboundBridgeState");

function getClawlineOutboundBridgeState(): ClawlineOutboundBridgeState {
  const globalState = globalThis as typeof globalThis & {
    [CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY]?: ClawlineOutboundBridgeState;
  };
  const existing = globalState[CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY];
  if (existing) {
    return existing;
  }
  // Temporary fork workaround for upstream issue #4231. Keep outbound bridge
  // ownership inside the Clawline extension, but store the live sender in a
  // process-global Symbol.for slot so split runtime chunks share one bridge.
  // Remove this when upstream offers an equivalent runtime/service-context fix.
  const created: ClawlineOutboundBridgeState = {
    currentSender: null,
  };
  globalState[CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY] = created;
  return created;
}

export function setClawlineOutboundSender(sender: ClawlineSendFn | null): void {
  getClawlineOutboundBridgeState().currentSender = sender;
}

export function hasClawlineOutboundSender(): boolean {
  return getClawlineOutboundBridgeState().currentSender !== null;
}

export async function sendClawlineOutboundMessage(
  params: ClawlineOutboundSendParams,
): Promise<ClawlineOutboundSendResult> {
  const sender = getClawlineOutboundBridgeState().currentSender;
  if (!sender) {
    throw new Error("clawline outbound delivery is not available (service not running)");
  }
  return await sender(params);
}
