/**
 * Helm Connection Manager
 *
 * Manages WebSocket connections from Helm (visionOS) devices.
 * Can be integrated with the Clawline server or run standalone.
 */

import type WebSocket from "ws";
import type {
  HelmRequest,
  HelmResponse,
  HelmDeviceInfo,
  HelmMessageEnvelope,
  ReadyResponse,
  ErrorResponse,
} from "./protocol.js";
import { HELM_PROTOCOL_VERSION } from "./protocol.js";
import { routeHelmResponse } from "./session-routing.js";

export interface HelmConnection {
  ws: WebSocket;
  deviceId: string;
  userId: string;
  deviceInfo: HelmDeviceInfo;
  connectedAt: Date;
  capabilities: string[];
  activeVisualizations: string[];
}

export interface HelmConnectionManagerOptions {
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  onResponse?: (userId: string, response: HelmResponse) => void;
}

export interface HelmConnectionManager {
  /** Register a new Helm connection. */
  registerConnection(params: {
    ws: WebSocket;
    deviceId: string;
    userId: string;
    deviceInfo: HelmDeviceInfo;
  }): HelmConnection;

  /** Remove a connection by device ID. */
  removeConnection(deviceId: string): void;

  /** Get a connection by device ID. */
  getConnection(deviceId: string): HelmConnection | undefined;

  /** Get all connections for a user. */
  getConnectionsForUser(userId: string): HelmConnection[];

  /** Send a request to a specific device. */
  sendToDevice(deviceId: string, request: HelmRequest): boolean;

  /** Send a request to all devices for a user. */
  sendToUser(userId: string, request: HelmRequest): number;

  /** Handle an incoming message from a Helm device. */
  handleMessage(deviceId: string, data: string | Buffer): void;

  /** Get count of connected devices. */
  getConnectionCount(): number;

  /** List all connected device IDs. */
  listConnectedDevices(): string[];
}

export function createHelmConnectionManager(
  options: HelmConnectionManagerOptions = {},
): HelmConnectionManager {
  const { logger, onResponse } = options;

  const connectionsByDevice = new Map<string, HelmConnection>();
  const devicesByUser = new Map<string, Set<string>>();

  function registerConnection(params: {
    ws: WebSocket;
    deviceId: string;
    userId: string;
    deviceInfo: HelmDeviceInfo;
  }): HelmConnection {
    const { ws, deviceId, userId, deviceInfo } = params;

    // Remove any existing connection for this device
    removeConnection(deviceId);

    const connection: HelmConnection = {
      ws,
      deviceId,
      userId,
      deviceInfo,
      connectedAt: new Date(),
      capabilities: [],
      activeVisualizations: [],
    };

    connectionsByDevice.set(deviceId, connection);

    // Track by user
    if (!devicesByUser.has(userId)) {
      devicesByUser.set(userId, new Set());
    }
    devicesByUser.get(userId)!.add(deviceId);

    logger?.info?.(`[helm] device connected: ${deviceId} (user: ${userId})`);

    // Send ready acknowledgment
    const readyResponse: ReadyResponse = {
      type: "ready",
      deviceId,
      capabilities: [],
      activeVisualizations: [],
    };
    sendEnvelope(ws, readyResponse);

    return connection;
  }

  function removeConnection(deviceId: string): void {
    const connection = connectionsByDevice.get(deviceId);
    if (!connection) return;

    connectionsByDevice.delete(deviceId);

    // Remove from user tracking
    const userDevices = devicesByUser.get(connection.userId);
    if (userDevices) {
      userDevices.delete(deviceId);
      if (userDevices.size === 0) {
        devicesByUser.delete(connection.userId);
      }
    }

    logger?.info?.(`[helm] device disconnected: ${deviceId}`);
  }

  function getConnection(deviceId: string): HelmConnection | undefined {
    return connectionsByDevice.get(deviceId);
  }

  function getConnectionsForUser(userId: string): HelmConnection[] {
    const deviceIds = devicesByUser.get(userId);
    if (!deviceIds) return [];

    const connections: HelmConnection[] = [];
    for (const deviceId of deviceIds) {
      const conn = connectionsByDevice.get(deviceId);
      if (conn) connections.push(conn);
    }
    return connections;
  }

  function sendEnvelope(ws: WebSocket, payload: HelmRequest | HelmResponse): boolean {
    if (ws.readyState !== 1 /* WebSocket.OPEN */) {
      return false;
    }

    const envelope: HelmMessageEnvelope = {
      version: HELM_PROTOCOL_VERSION,
      timestamp: Date.now(),
      payload,
    };

    try {
      ws.send(JSON.stringify(envelope));
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger?.error?.(`[helm] send failed: ${errMsg}`);
      return false;
    }
  }

  function sendToDevice(deviceId: string, request: HelmRequest): boolean {
    const connection = connectionsByDevice.get(deviceId);
    if (!connection) {
      logger?.warn?.(`[helm] device not found: ${deviceId}`);
      return false;
    }

    logger?.debug?.(`[helm] sending ${request.type} to ${deviceId}`);
    return sendEnvelope(connection.ws, request);
  }

  function sendToUser(userId: string, request: HelmRequest): number {
    const connections = getConnectionsForUser(userId);
    let sent = 0;

    for (const conn of connections) {
      if (sendEnvelope(conn.ws, request)) {
        sent++;
      }
    }

    logger?.debug?.(
      `[helm] sent ${request.type} to ${sent}/${connections.length} devices for user ${userId}`,
    );
    return sent;
  }

  function handleMessage(deviceId: string, data: string | Buffer): void {
    const connection = connectionsByDevice.get(deviceId);
    if (!connection) {
      logger?.warn?.(`[helm] message from unknown device: ${deviceId}`);
      return;
    }

    try {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      const envelope = JSON.parse(raw) as HelmMessageEnvelope<HelmResponse>;

      // Validate envelope
      if (typeof envelope.version !== "number" || !envelope.payload) {
        throw new Error("Invalid envelope structure");
      }

      const response = envelope.payload;
      logger?.debug?.(`[helm] received ${response.type} from ${deviceId}`);

      // Update connection state based on response type
      if (response.type === "ready") {
        connection.capabilities = response.capabilities ?? [];
        connection.activeVisualizations = response.activeVisualizations ?? [];
      } else if (response.type === "created") {
        if (!connection.activeVisualizations.includes(response.vizId)) {
          connection.activeVisualizations.push(response.vizId);
        }
      }

      // Forward to callback (legacy)
      if (onResponse) {
        onResponse(connection.userId, response);
      }

      // Route to session system
      routeHelmResponse({
        userId: connection.userId,
        deviceId: connection.deviceId,
        response,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger?.error?.(`[helm] failed to parse message from ${deviceId}: ${errMsg}`);

      // Send error response back
      const errorResponse: ErrorResponse = {
        type: "error",
        code: "PARSE_ERROR",
        message: `Failed to parse message: ${errMsg}`,
        recoverable: true,
      };
      sendEnvelope(connection.ws, errorResponse);
    }
  }

  function getConnectionCount(): number {
    return connectionsByDevice.size;
  }

  function listConnectedDevices(): string[] {
    return Array.from(connectionsByDevice.keys());
  }

  return {
    registerConnection,
    removeConnection,
    getConnection,
    getConnectionsForUser,
    sendToDevice,
    sendToUser,
    handleMessage,
    getConnectionCount,
    listConnectedDevices,
  };
}
