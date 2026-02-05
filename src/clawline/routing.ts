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
export type ClawlineDeliveryTarget = string;
