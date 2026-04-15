/**
 * Tier 1 — Topic Refiner Agent
 *
 * Called after human approval with notes.
 * Applies human feedback to a single topic card — one focused iteration only.
 * Does NOT re-score or re-evaluate — the human's approval already covers that.
 *
 * Examples of refinements handled:
 *   - "Make the title less clinical"       → rewrites H1 only
 *   - "Connect to MD-RIC more directly"   → updates feature + rationale
 *   - "Too close to what Healthline owns" → shifts to a more specific long-tail keyword
 *   - "Wrong season for this"             → swaps topic to a seasonally better angle
 */

import { callClaudeJSON } from "../lib/claude";
import { logger } from "../lib/logger";
import type { TopicCard } from "../types";

const SYSTEM_PROMPT = `You are the Topic Refiner for RespireLYF — a respiratory health app for US adults with asthma or COPD.

A human reviewer has approved a blog topic but left specific notes requesting a small adjustment.
Your job: apply ONLY the requested change. Do not rewrite everything. Minimal targeted edits only.

RULES:
- Title must remain under 60 characters
- Primary keyword must remain patient-language (not brand vocabulary)
- Feature mapping must remain valid (only change if the human explicitly asked for it)
- Rationale should be updated if the angle changes
- Banned words: journey, empower, transform, game-changer, revolutionary, unlock
- Never change the topic_type or ymyl_flag unless the human explicitly asked

Return the FULL updated topic object as JSON (all fields, even unchanged ones).`;

export async function runTopicRefiner(
  card: TopicCard,
  humanNotes: string,
  run_id: string
): Promise<TopicCard> {
  logger.info("topic_refiner", `Refining topic: "${card.title}"`, { run_id });
  logger.info("topic_refiner", `Human notes: ${humanNotes}`, { run_id });

  const raw = await callClaudeJSON<Omit<TopicCard, "id" | "pipeline_run_id" | "generated_at" | "approval_status">>({
    stage: "topic_refiner",
    run_id,
    system: SYSTEM_PROMPT,
    user: `CURRENT TOPIC:
${JSON.stringify({
  title: card.title,
  primary_keyword: card.primary_keyword,
  rationale: card.rationale,
  respireLYF_feature: card.respireLYF_feature,
  intent_strength: card.intent_strength,
  topic_type: card.topic_type,
  ymyl_flag: card.ymyl_flag,
}, null, 2)}

HUMAN NOTES (apply these changes):
"${humanNotes}"

Return the refined topic as a single JSON object with all fields.`,
    temperature: 0.2,
  });

  const refined: TopicCard = {
    ...card,
    title:              raw.title ?? card.title,
    primary_keyword:    raw.primary_keyword ?? card.primary_keyword,
    rationale:          raw.rationale ?? card.rationale,
    respireLYF_feature: raw.respireLYF_feature ?? card.respireLYF_feature,
    intent_strength:    raw.intent_strength ?? card.intent_strength,
    human_notes:        humanNotes,
    refined_at:         new Date().toISOString(),
    iteration_count:    card.iteration_count + 1,
  };

  // Enforce 60-char title limit
  if (refined.title.length > 60) {
    refined.title = refined.title.slice(0, 57) + "...";
  }

  logger.info("topic_refiner", `Refined: "${card.title}" → "${refined.title}"`, { run_id });

  return refined;
}
