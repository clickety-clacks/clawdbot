/**
 * Helm Outbound Message Delivery
 *
 * Provides a sender function that can be used by the helm channel plugin
 * to send visualization requests to connected Helm devices.
 */

import type { HelmRequest } from "./protocol.js";

export type HelmOutboundSendParams = {
  /** Target user ID (sends to all user's connected Helm devices). */
  userId: string;
  /** The visualization request to send. */
  request: HelmRequest;
};

export type HelmOutboundSendResult = {
  /** Number of devices the request was sent to. */
  deviceCount: number;
  /** Whether at least one device received the request. */
  ok: boolean;
  /** Error message if send failed. */
  error?: string;
};

type HelmSendFn = (params: HelmOutboundSendParams) => Promise<HelmOutboundSendResult>;

let currentSender: HelmSendFn | null = null;

export function setHelmOutboundSender(sender: HelmSendFn | null): void {
  currentSender = sender;
}

export function hasHelmOutboundSender(): boolean {
  return currentSender !== null;
}

export async function sendHelmRequest(
  params: HelmOutboundSendParams,
): Promise<HelmOutboundSendResult> {
  const sender = currentSender;
  if (!sender) {
    return {
      deviceCount: 0,
      ok: false,
      error: "Helm outbound delivery is not available (no connected devices)",
    };
  }
  return await sender(params);
}

/**
 * Helper to create a VisualizeRequest from message tool params.
 */
export function createVisualizeRequestFromMessage(params: {
  content: string;
  style?: string;
  layout?: string;
}): HelmRequest {
  const id = `viz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    type: "visualize",
    id,
    content: params.content,
    style: params.style as HelmRequest["type"] extends "visualize"
      ? NonNullable<Extract<HelmRequest, { type: "visualize" }>["style"]>
      : undefined,
    layout: params.layout as HelmRequest["type"] extends "visualize"
      ? NonNullable<Extract<HelmRequest, { type: "visualize" }>["layout"]>
      : undefined,
  };
}
