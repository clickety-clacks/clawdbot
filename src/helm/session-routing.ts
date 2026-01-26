/**
 * Helm Session Routing
 *
 * Routes Helm responses back to the originating CLU session.
 * When a Helm device sends a response (created, interaction, error),
 * it gets injected into the agent's session as a system message.
 */

import type {
  HelmResponse,
  CreatedResponse,
  InteractionResponse,
  ErrorResponse,
} from "./protocol.js";

export type HelmResponseCallback = (params: {
  userId: string;
  deviceId: string;
  response: HelmResponse;
}) => void;

let responseCallback: HelmResponseCallback | null = null;

/**
 * Set the callback for handling Helm responses.
 * This is called by the gateway/agent system to receive Helm feedback.
 */
export function setHelmResponseCallback(callback: HelmResponseCallback | null): void {
  responseCallback = callback;
}

/**
 * Check if a response callback is registered.
 */
export function hasHelmResponseCallback(): boolean {
  return responseCallback !== null;
}

/**
 * Route a Helm response to the appropriate session.
 * Called by the HelmConnectionManager when a response is received.
 */
export function routeHelmResponse(params: {
  userId: string;
  deviceId: string;
  response: HelmResponse;
}): void {
  if (responseCallback) {
    responseCallback(params);
  }
}

/**
 * Format a Helm response as a human-readable string for session injection.
 */
export function formatHelmResponseForSession(response: HelmResponse): string {
  switch (response.type) {
    case "created": {
      const created = response as CreatedResponse;
      const elements =
        created.elements.length > 0 ? ` with ${created.elements.length} elements` : "";
      return `[Helm] Visualization created (${created.vizId}): ${created.description}${elements}`;
    }

    case "interaction": {
      const interaction = response as InteractionResponse;
      return `[Helm] User ${interaction.action} on "${interaction.target}" in visualization ${interaction.vizId}`;
    }

    case "state": {
      return `[Helm] Visualization state: ${response.visible.length} visible, ${response.highlighted.length} highlighted`;
    }

    case "error": {
      const error = response as ErrorResponse;
      const vizRef = error.vizId ? ` (viz: ${error.vizId})` : "";
      const recoverable = error.recoverable ? " (recoverable)" : "";
      return `[Helm] Error${vizRef}: ${error.message}${recoverable}`;
    }

    case "ready": {
      return `[Helm] Device ready: ${response.capabilities.join(", ") || "basic visualization"}`;
    }

    default:
      return `[Helm] Response: ${JSON.stringify(response)}`;
  }
}

/**
 * Determine if a Helm response should be injected into the session.
 * Some responses (like ready) might not need to interrupt the agent.
 */
export function shouldInjectResponse(response: HelmResponse): boolean {
  switch (response.type) {
    case "created":
    case "interaction":
    case "error":
      return true;
    case "state":
      // Only inject state if it was explicitly requested
      return true;
    case "ready":
      // Don't interrupt the agent just because a device connected
      return false;
    default:
      return false;
  }
}

/**
 * Get the priority level of a Helm response.
 * Higher priority responses should be handled more urgently.
 */
export function getResponsePriority(response: HelmResponse): "high" | "normal" | "low" {
  switch (response.type) {
    case "error":
      return "high";
    case "interaction":
      return "high";
    case "created":
      return "normal";
    case "state":
      return "normal";
    case "ready":
      return "low";
    default:
      return "low";
  }
}
