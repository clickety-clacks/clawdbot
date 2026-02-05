/**
 * Clawline Delivery Target (CANONICAL FORMAT)
 *
 * Format: {userId}:{sessionLabel}
 * Example: flynn:main
 *
 * IMPORTANT:
 * - This is NOT a session key.
 * - This is NOT user:flynn (no prefix).
 * - This value goes into lastTo when lastChannel=clawline.
 * - This value goes into OriginatingTo for Clawline inbound.
 *
 * Relationship to session keys:
 * - Session key: agent:main:clawline:flynn:main
 * - Delivery target: flynn:main
 * - lastChannel: clawline
 *
 * WARNINGS:
 * - DO NOT add prefixes (user:/device:/clawline:/etc).
 * - DO NOT add device variants here.
 * - DO NOT cargo-cult formats from Discord/Slack/Telegram.
 */
/**
 * NAMESPACE DESIGN
 *
 * CURRENTLY SUPPORTED:
 * - User sessions: {userId}:{sessionLabel} (e.g., flynn:main)
 * - Only 'main' sessionLabel is implemented; others reserved for future use
 *
 * NOT YET IMPLEMENTED (future):
 * - Additional user session labels (e.g., flynn:secondary, flynn:hobby)
 * - Group channels: {groupName} with no colon (e.g., general)
 *
 * The colon distinguishes user sessions from groups.
 * DO NOT implement group support without updating this type.
 */
export class ClawlineDeliveryTarget {
  private constructor(
    private readonly rawUserId: string,
    private readonly rawSessionLabel: string,
  ) {}

  static fromString(raw: string): ClawlineDeliveryTarget {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Invalid Clawline delivery target: empty");
    }
    const parts = trimmed.split(":");
    if (parts.length !== 2) {
      throw new Error("Invalid Clawline delivery target: must be userId:sessionLabel");
    }
    const userId = parts[0]?.trim() ?? "";
    const sessionLabel = parts[1]?.trim() ?? "";
    if (!userId || !sessionLabel) {
      throw new Error("Invalid Clawline delivery target: missing userId or sessionLabel");
    }
    return new ClawlineDeliveryTarget(userId, sessionLabel);
  }

  static fromParts(userId: string, sessionLabel: string): ClawlineDeliveryTarget {
    const trimmedUserId = userId.trim();
    const trimmedSessionLabel = sessionLabel.trim();
    if (!trimmedUserId || !trimmedSessionLabel) {
      throw new Error("Invalid Clawline delivery target: missing userId or sessionLabel");
    }
    return new ClawlineDeliveryTarget(trimmedUserId, trimmedSessionLabel);
  }

  static fromSessionKey(sessionKey: string): ClawlineDeliveryTarget {
    const parts = sessionKey.split(":");
    if (parts.length < 5) {
      throw new Error("Invalid Clawline session key");
    }
    if (parts[0].toLowerCase() !== "agent" || parts[2].toLowerCase() !== "clawline") {
      throw new Error("Not a Clawline session key");
    }
    const userId = parts[3]?.trim() ?? "";
    const sessionLabel = parts[4]?.trim() ?? "";
    if (!userId || !sessionLabel) {
      throw new Error("Invalid Clawline session key: missing userId or sessionLabel");
    }
    return new ClawlineDeliveryTarget(userId, sessionLabel);
  }

  userId(): string {
    return this.rawUserId;
  }

  sessionLabel(): string {
    return this.rawSessionLabel;
  }

  toSessionKey(agentId = "main"): string {
    const normalizedAgentId = agentId.trim().toLowerCase() || "main";
    return `agent:${normalizedAgentId}:clawline:${this.rawUserId}:${this.rawSessionLabel}`;
  }

  toString(): string {
    return `${this.rawUserId}:${this.rawSessionLabel}`;
  }
}
