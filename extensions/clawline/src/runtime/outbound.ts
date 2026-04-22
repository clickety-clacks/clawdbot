import { AsyncLocalStorage } from "node:async_hooks";
import type { ClawlineOutboundSendParams, ClawlineOutboundSendResult } from "./domain.js";

type ClawlineSendFn = (params: ClawlineOutboundSendParams) => Promise<ClawlineOutboundSendResult>;
export type ClawlineOutboundSenderOwnerToken = symbol;
type ClawlineOutboundCorrelation = Pick<
  ClawlineOutboundSendParams,
  "replyToMessageId" | "replyToClientMessageId"
>;

type ClawlineOutboundBridgeState = {
  ownerToken: ClawlineOutboundSenderOwnerToken | null;
  currentSender: ClawlineSendFn | null;
};

const CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY = Symbol.for("openclaw.clawline.outboundBridgeState");
const outboundCorrelation = new AsyncLocalStorage<ClawlineOutboundCorrelation>();

function getClawlineOutboundBridgeGlobalStore(): typeof globalThis & {
  [CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY]?: ClawlineOutboundBridgeState;
} {
  return globalThis as typeof globalThis & {
    [CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY]?: ClawlineOutboundBridgeState;
  };
}

function getClawlineOutboundBridgeState(): ClawlineOutboundBridgeState | undefined {
  return getClawlineOutboundBridgeGlobalStore()[CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY];
}

function createClawlineOutboundBridgeState(
  ownerToken: ClawlineOutboundSenderOwnerToken | null,
  sender: ClawlineSendFn,
): ClawlineOutboundBridgeState {
  // Temporary fork workaround for upstream issue #4231. Keep outbound bridge
  // ownership inside the Clawline extension, but store the live sender in a
  // process-global Symbol.for slot so split runtime chunks share one bridge.
  // Runtime owners clear only their own entry so stale stop hooks cannot tear
  // down a replacement sender. Remove this when upstream offers an equivalent
  // runtime/service-context fix.
  return {
    ownerToken,
    currentSender: sender,
  };
}

export function createClawlineOutboundSenderOwnerToken(): ClawlineOutboundSenderOwnerToken {
  return Symbol("openclaw.clawline.outboundSenderOwner");
}

export function setClawlineOutboundSender(
  sender: ClawlineSendFn | null,
  ownerToken?: ClawlineOutboundSenderOwnerToken,
): void {
  const globalState = getClawlineOutboundBridgeGlobalStore();
  if (!sender) {
    const existing = globalState[CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY];
    if (!existing) {
      return;
    }
    if (ownerToken !== undefined && existing.ownerToken !== ownerToken) {
      return;
    }
    delete globalState[CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY];
    return;
  }
  globalState[CLAWLINE_OUTBOUND_BRIDGE_STATE_KEY] = createClawlineOutboundBridgeState(
    ownerToken ?? null,
    sender,
  );
}

export function hasClawlineOutboundSender(): boolean {
  return getClawlineOutboundBridgeState()?.currentSender != null;
}

export async function sendClawlineOutboundMessage(
  params: ClawlineOutboundSendParams,
): Promise<ClawlineOutboundSendResult> {
  const sender = getClawlineOutboundBridgeState()?.currentSender;
  if (!sender) {
    throw new Error("clawline outbound delivery is not available (service not running)");
  }
  const correlation = outboundCorrelation.getStore();
  return await sender({
    ...params,
    replyToMessageId: params.replyToMessageId ?? correlation?.replyToMessageId,
    replyToClientMessageId: params.replyToClientMessageId ?? correlation?.replyToClientMessageId,
  });
}

export async function runWithClawlineOutboundCorrelation<T>(
  correlation: ClawlineOutboundCorrelation,
  task: () => Promise<T>,
): Promise<T> {
  return await outboundCorrelation.run(correlation, task);
}
