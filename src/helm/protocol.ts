/**
 * Helm Channel Protocol Types
 *
 * Defines the message protocol between CLU (Clawdbot) and Helm (visionOS visualization client).
 *
 * Message flow:
 *   CLU → Gateway → Helm App → 3D display
 *   Helm App → Gateway → CLU session
 */

// ============================================================================
// CLU → Helm Request Types
// ============================================================================

export interface VisualizeRequest {
  type: "visualize";
  id: string;
  content: string;
  style?: "technical" | "organic" | "minimal" | "dramatic";
  layout?: "radial" | "hierarchical" | "timeline" | "grid" | "freeform";
  highlight?: string[];
  context?: Record<string, unknown>;
}

export interface UpdateRequest {
  type: "update";
  vizId: string;
  action: "add" | "remove" | "modify" | "highlight" | "focus" | "reset";
  changes: Record<string, unknown>;
  animate?: boolean;
}

export interface CloseRequest {
  type: "close";
  vizId: string;
  animate?: boolean;
}

export interface QueryRequest {
  type: "query";
  vizId: string;
  question: string;
}

export interface ArrangeRequest {
  type: "arrange";
  /** Known values: side-by-side, stacked, carousel. Custom layouts allowed. */
  layout: string;
  vizIds: string[];
  primary?: string;
}

export type HelmRequest =
  | VisualizeRequest
  | UpdateRequest
  | CloseRequest
  | QueryRequest
  | ArrangeRequest;

// ============================================================================
// Helm → CLU Response Types
// ============================================================================

export interface Position3D {
  x: number;
  y: number;
  z: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export interface CreatedResponse {
  type: "created";
  vizId: string;
  description: string;
  elements: string[];
  position?: Position3D;
}

export interface InteractionResponse {
  type: "interaction";
  vizId: string;
  action: "select" | "drag" | "pinch" | "look" | "dismiss";
  target: string;
  details?: Record<string, unknown>;
}

export interface StateResponse {
  type: "state";
  vizId: string;
  visible: string[];
  highlighted: string[];
  focusedElement?: string;
  windowPosition: Position3D;
  windowSize: Size2D;
}

export interface ErrorResponse {
  type: "error";
  vizId?: string;
  code: string;
  message: string;
  recoverable: boolean;
}

export interface ReadyResponse {
  type: "ready";
  deviceId: string;
  capabilities: string[];
  activeVisualizations: string[];
}

export type HelmResponse =
  | CreatedResponse
  | InteractionResponse
  | StateResponse
  | ErrorResponse
  | ReadyResponse;

// ============================================================================
// WebSocket Envelope Types
// ============================================================================

export interface HelmMessageEnvelope<T = HelmRequest | HelmResponse> {
  version: number;
  timestamp: number;
  correlationId?: string;
  payload: T;
}

export interface HelmRegistration {
  type: "register";
  deviceId: string;
  userId: string;
  token: string;
  deviceInfo: HelmDeviceInfo;
}

export interface HelmDeviceInfo {
  platform: string;
  model: string;
  osVersion?: string;
  appVersion?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isVisualizeRequest(msg: HelmRequest): msg is VisualizeRequest {
  return msg.type === "visualize";
}

export function isUpdateRequest(msg: HelmRequest): msg is UpdateRequest {
  return msg.type === "update";
}

export function isCloseRequest(msg: HelmRequest): msg is CloseRequest {
  return msg.type === "close";
}

export function isQueryRequest(msg: HelmRequest): msg is QueryRequest {
  return msg.type === "query";
}

export function isArrangeRequest(msg: HelmRequest): msg is ArrangeRequest {
  return msg.type === "arrange";
}

export function isCreatedResponse(msg: HelmResponse): msg is CreatedResponse {
  return msg.type === "created";
}

export function isInteractionResponse(msg: HelmResponse): msg is InteractionResponse {
  return msg.type === "interaction";
}

export function isStateResponse(msg: HelmResponse): msg is StateResponse {
  return msg.type === "state";
}

export function isErrorResponse(msg: HelmResponse): msg is ErrorResponse {
  return msg.type === "error";
}

export function isReadyResponse(msg: HelmResponse): msg is ReadyResponse {
  return msg.type === "ready";
}

// ============================================================================
// Constants
// ============================================================================

export const HELM_PROTOCOL_VERSION = 1;

export const HELM_REQUEST_TYPES = ["visualize", "update", "close", "query", "arrange"] as const;

export const HELM_RESPONSE_TYPES = ["created", "interaction", "state", "error", "ready"] as const;

export const HELM_VISUALIZATION_STYLES = ["technical", "organic", "minimal", "dramatic"] as const;

export const HELM_LAYOUT_TYPES = [
  "radial",
  "hierarchical",
  "timeline",
  "grid",
  "freeform",
] as const;

export const HELM_UPDATE_ACTIONS = [
  "add",
  "remove",
  "modify",
  "highlight",
  "focus",
  "reset",
] as const;

export const HELM_INTERACTION_ACTIONS = ["select", "drag", "pinch", "look", "dismiss"] as const;

export const HELM_ARRANGE_LAYOUTS = ["side-by-side", "stacked", "carousel"] as const;
