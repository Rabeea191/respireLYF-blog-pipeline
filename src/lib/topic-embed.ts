/**
 * Topic JSON embedding — shared helpers
 *
 * We transport the full TopicCard inside each ClickUp task's description
 * using a hidden fenced code block. This lets us treat ClickUp as the
 * single source of truth for topic state: pending, approved, rejected,
 * or approved-with-notes. No separate database needed.
 *
 * Both the notification layer (src/notifications/clickup.ts) and the
 * webhook / Tier 2 orchestrator read this format, so the constants and
 * parse / build helpers live here to keep them in lock-step.
 */

import { logger } from "./logger";
import type { TopicCard } from "../types";

export const TOPIC_BLOCK_OPEN  = "```json respire-lyf-topic";
export const TOPIC_BLOCK_CLOSE = "```";

/** Extract the embedded TopicCard JSON from a ClickUp task description. */
export function extractEmbeddedTopic(
  description: string | null | undefined,
): TopicCard | null {
  if (!description) return null;
  const start = description.indexOf(TOPIC_BLOCK_OPEN);
  if (start === -1) return null;
  const contentStart = start + TOPIC_BLOCK_OPEN.length;
  const end = description.indexOf(TOPIC_BLOCK_CLOSE, contentStart);
  if (end === -1) return null;
  const jsonRaw = description.slice(contentStart, end).trim();
  try {
    return JSON.parse(jsonRaw) as TopicCard;
  } catch (err) {
    logger.warn("topic_embed", `Failed to parse embedded topic JSON: ${String(err)}`);
    return null;
  }
}

/** Build the hidden fenced JSON block that carries the full TopicCard. */
export function buildEmbeddedTopicBlock(card: TopicCard): string {
  return `\n\n${TOPIC_BLOCK_OPEN}\n${JSON.stringify(card, null, 2)}\n${TOPIC_BLOCK_CLOSE}\n`;
}
