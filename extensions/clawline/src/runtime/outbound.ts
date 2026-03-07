import type { ClawlineOutboundSendParams, ClawlineOutboundSendResult } from "./domain.js";

type ClawlineSendFn = (params: ClawlineOutboundSendParams) => Promise<ClawlineOutboundSendResult>;

let currentSender: ClawlineSendFn | null = null;

export function setClawlineOutboundSender(sender: ClawlineSendFn | null): void {
  currentSender = sender;
}

export function hasClawlineOutboundSender(): boolean {
  return currentSender !== null;
}

export async function sendClawlineOutboundMessage(
  params: ClawlineOutboundSendParams,
): Promise<ClawlineOutboundSendResult> {
  const sender = currentSender;
  if (!sender) {
    throw new Error("clawline outbound delivery is not available (service not running)");
  }
  return await sender(params);
}
