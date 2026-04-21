/**
 * ClickUp Integration — Topic Approval Flow
 *
 * Each topic card becomes a ClickUp task in your designated list.
 * The human reviewer changes task status in ClickUp to approve/reject.
 * A webhook listener (api/clickup-webhook.ts) picks up the status change
 * and routes it back into the pipeline.
 *
 * Task structure per topic:
 *   Name:        "[Week of Apr 14] Why Cold Air Triggers Asthma"
 *   Description: Full topic card details + evaluator score + editorial note
 *   Priority:    Based on evaluator gate_flag (urgent=revise, normal=caution/clean)
 *   Tags:        topic-review, week-YYYY-MM-DD, gate_flag
 *   Custom Fields (configure these in your ClickUp list):
 *     - primary_keyword (text)
 *     - evaluator_score (number)
 *     - gate_flag (dropdown: clean | caution | revise)
 *     - pipeline_run_id (text)
 *     - topic_card_id (text)
 */

import axios from "axios";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { buildEmbeddedTopicBlock } from "../lib/topic-embed";
import type { TopicCard, PipelineRun } from "../types";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";

const headers = {
  Authorization: config.clickup.apiKey,
  "Content-Type": "application/json",
};

/** Stamp the pipeline run id into the card before we embed it. */
function embedTopicForTask(card: TopicCard, run: PipelineRun): string {
  return buildEmbeddedTopicBlock({
    ...card,
    pipeline_run_id: card.pipeline_run_id || run.id,
  });
}

// ─── Priority mapping ─────────────────────────────────────────────────────────
function getPriority(flag: string): number {
  // ClickUp priorities: 1=urgent, 2=high, 3=normal, 4=low
  if (flag === "clean")   return 3; // normal
  if (flag === "caution") return 2; // high
  return 1;                         // urgent — needs regeneration
}

// ─── Build task description ───────────────────────────────────────────────────
function buildDescription(card: TopicCard, run: PipelineRun): string {
  const scores = card.evaluation?.scores;
  const flag = card.evaluation?.gate_flag ?? "unknown";
  const flagEmoji = { clean: "✅", caution: "⚠️", revise: "🔄", unknown: "❓" }[flag];

  return `## ${flagEmoji} Topic Card — ${flag.toUpperCase()}

**Week of:** ${run.week_of}
**Pipeline Run:** ${run.id}
**Topic ID:** ${card.id}

---

## Topic Details

| Field | Value |
|-------|-------|
| **Title** | ${card.title} |
| **Primary Keyword** | ${card.primary_keyword} |
| **Feature** | ${card.respireLYF_feature} |
| **Intent** | ${card.intent_strength} |
| **Type** | ${card.topic_type} |
| **YMYL** | ${card.ymyl_flag ? "Yes — needs 'When to See a Doctor' section" : "No"} |

## Rationale
${card.rationale}

---

## Evaluator Score: ${scores?.total ?? "N/A"}/50

| Dimension | Score |
|-----------|-------|
| SEO Potential | ${scores?.seo_potential ?? "-"}/10 |
| Brand Fit | ${scores?.brand_fit ?? "-"}/10 |
| Reader Urgency | ${scores?.reader_urgency ?? "-"}/10 |
| Content Differentiation | ${scores?.content_differentiation ?? "-"}/10 |
| FDA-Safe Angle | ${scores?.fda_safe_angle ?? "-"}/10 |

**Editorial Note:** ${card.evaluation?.editorial_note ?? "—"}

---

## How to Action This Task

**To APPROVE:** Change status to → \`${config.clickup.statuses.approved}\`
**To APPROVE WITH NOTES:** Change status to → \`${config.clickup.statuses.approvedWithNotes}\` and add a comment with your notes
**To REJECT:** Change status to → \`${config.clickup.statuses.rejected}\` and add a comment explaining why

The pipeline will automatically pick up your decision via webhook within 1 minute.`;
}

// ─── Create a ClickUp task for a single topic card ────────────────────────────
export async function createTopicTask(
  card: TopicCard,
  run: PipelineRun
): Promise<string> {
  const weekOf = new Date(run.week_of).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });

  const flag = card.evaluation?.gate_flag ?? "pending";

  // Human-readable description + hidden JSON block for machine rehydration.
  // The webhook and Tier 2 trigger read the JSON block via extractEmbeddedTopic().
  const description = buildDescription(card, run) + embedTopicForTask(card, run);

  const payload = {
    name: `[Week of ${weekOf}] ${card.title}`,
    description,
    status: config.clickup.statuses.pending,
    priority: getPriority(flag),
    tags: ["topic-review", `week-${run.week_of}`, `gate-${flag}`],
    // Store pipeline metadata in task for webhook routing
    custom_fields: [] as Array<{ id: string; value: string | number }>,
  };

  const { data } = await axios.post(
    `${CLICKUP_BASE}/list/${config.clickup.listId}/task`,
    payload,
    { headers }
  );

  logger.info("clickup", `Created task for "${card.title}" → ${data.id}`, {
    run_id: run.id,
    data: { clickup_task_id: data.id },
  });

  return data.id as string;
}

// ─── Post all 5 topic cards for a pipeline run ────────────────────────────────
export async function postTopicsToClickUp(
  cards: TopicCard[],
  run: PipelineRun
): Promise<Map<string, string>> {
  logger.info("clickup", `Posting ${cards.length} topic cards to ClickUp`, { run_id: run.id });

  const taskIdMap = new Map<string, string>(); // card.id → clickup_task_id

  // Post sequentially to avoid rate limits
  for (const card of cards) {
    try {
      const taskId = await createTopicTask(card, run);
      taskIdMap.set(card.id, taskId);
      // Small delay to respect ClickUp rate limits (100 req/min)
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      logger.error("clickup", `Failed to create task for "${card.title}"`, {
        run_id: run.id,
        data: { error: String(err) },
      });
    }
  }

  logger.info("clickup", `Posted ${taskIdMap.size}/${cards.length} tasks successfully`, { run_id: run.id });
  return taskIdMap;
}

// ─── Add a comment to a task (used for approval with notes feedback) ──────────
export async function addTaskComment(
  taskId: string,
  comment: string,
  run_id: string
): Promise<void> {
  await axios.post(
    `${CLICKUP_BASE}/task/${taskId}/comment`,
    { comment_text: comment },
    { headers }
  );
  logger.info("clickup", `Added comment to task ${taskId}`, { run_id });
}

// ─── Get task details (for polling fallback if webhook fails) ─────────────────
export async function getTaskStatus(taskId: string): Promise<string> {
  const { data } = await axios.get(`${CLICKUP_BASE}/task/${taskId}`, { headers });
  return data?.status?.status ?? "unknown";
}
