/**
 * ClickUp Webhook Handler — Source of Truth is ClickUp
 *
 * No database needed. The full TopicCard JSON lives inside each ClickUp
 * task's description as a hidden fenced code block. That makes ClickUp
 * the single source of truth for what is pending / approved / rejected.
 *
 * Events handled:
 *   taskStatusUpdated  — when a human flips a topic task to Approved,
 *                        we count approved topic tasks and, if we are at
 *                        the threshold, fire the Tier 2 trigger endpoint.
 *   taskCommentPosted  — when a human leaves notes on a task that is in
 *                        "Approved - Needs Tweak" status, we run the
 *                        Topic Refiner and auto-advance the task to
 *                        Approved (which re-fires the status webhook).
 *
 * Deploy as: /api/pipeline/clickup-webhook
 * Register at: ClickUp Settings → Integrations → Webhooks
 *              events: taskStatusUpdated, taskCommentPosted
 */

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import axios from "axios";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { runTopicRefiner } from "../agents/topic-refiner";
import {
  extractEmbeddedTopic,
  buildEmbeddedTopicBlock,
  TOPIC_BLOCK_OPEN,
  TOPIC_BLOCK_CLOSE,
} from "../lib/topic-embed";
import type { TopicCard } from "../types";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";

// Re-export for any external callers that still reference this module.
export { extractEmbeddedTopic };

// ─── Verify ClickUp webhook signature ────────────────────────────────────────
function verifySignature(req: NextApiRequest, rawBody: string): boolean {
  if (!config.clickup.webhookSecret) return true; // Skip if not configured
  const signature = req.headers["x-signature"] as string;
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", config.clickup.webhookSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── ClickUp API helpers ─────────────────────────────────────────────────────
const headers = {
  Authorization: config.clickup.apiKey,
  "Content-Type": "application/json",
};

interface ClickUpTask {
  id: string;
  status: { status: string };
  description?: string;
  text_content?: string;
}

async function fetchListTasks(): Promise<ClickUpTask[]> {
  // ClickUp caps at 100 tasks per page — for a weekly topic list we're fine.
  // Timeout is generous because ClickUp's API occasionally goes slow and a
  // 10s budget wasn't enough — if this call fails we can't count approvals.
  const { data } = await axios.get(
    `${CLICKUP_BASE}/list/${config.clickup.listId}/task`,
    {
      headers,
      params: { include_closed: false, subtasks: false, page: 0 },
      timeout: 30_000,
    }
  );
  return (data?.tasks ?? []) as ClickUpTask[];
}

async function fetchTask(taskId: string): Promise<ClickUpTask | null> {
  try {
    const { data } = await axios.get(`${CLICKUP_BASE}/task/${taskId}`, {
      headers,
      timeout: 30_000,
    });
    return data as ClickUpTask;
  } catch (err: any) {
    logger.warn("clickup_webhook", `Failed to fetch task ${taskId}: ${err.message}`);
    return null;
  }
}

async function updateTask(
  taskId: string,
  updates: { description?: string; status?: string }
): Promise<void> {
  await axios.put(`${CLICKUP_BASE}/task/${taskId}`, updates, { headers });
}

/** Count pipeline tasks whose ClickUp status is Approved. */
async function countApprovedPipelineTasks(): Promise<number> {
  const tasks = await fetchListTasks();
  const approvedLower = config.clickup.statuses.approved.toLowerCase();
  let count = 0;
  for (const t of tasks) {
    const status = (t.status?.status ?? "").toLowerCase();
    if (status !== approvedLower) continue;
    // Only count tasks with our embedded topic JSON (ignore ad-hoc tasks)
    if (!extractEmbeddedTopic(t.description ?? t.text_content ?? "")) continue;
    count++;
  }
  return count;
}

/** Fire the Tier 2 trigger endpoint (fire-and-forget). */
async function fireTier2Trigger(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/pipeline/tier2-trigger`;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error("clickup_webhook", "CRON_SECRET missing — cannot fire Tier 2 trigger");
    return;
  }

  logger.info("clickup_webhook", `Firing Tier 2 trigger → ${url}`);
  try {
    // Short timeout because Tier 2 runs long — the endpoint responds 202
    // immediately and runs the pipeline async.
    await axios.post(url, {}, {
      headers: { Authorization: `Bearer ${cronSecret}` },
      timeout: 10_000,
    });
  } catch (err: any) {
    // If it 202s fast, we'll be fine. If it errors, log it.
    if (err?.response?.status === 202 || err?.response?.status === 200) return;
    logger.warn(
      "clickup_webhook",
      `Tier 2 trigger call returned unexpected result: ${err?.response?.status ?? err.message}`
    );
  }
}

function resolveBaseUrl(): string {
  if (process.env.PIPELINE_BASE_URL) return process.env.PIPELINE_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = JSON.stringify(req.body);
  if (!verifySignature(req, rawBody)) {
    logger.warn("clickup_webhook", "Invalid webhook signature — rejected");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { event, task_id, history_items } = req.body as {
    event: string;
    task_id: string;
    history_items?: Array<{
      field: string;
      after?: { status: string };
      comment?: { text_content: string };
    }>;
  };

  // Acknowledge immediately — ClickUp expects 200 within 5s
  res.status(200).json({ received: true });

  try {
    if (event === "taskStatusUpdated") {
      await handleStatusUpdate(task_id, history_items ?? []);
    } else if (event === "taskCommentPosted") {
      await handleCommentPosted(task_id, history_items ?? []);
    } else {
      logger.debug("clickup_webhook", `Ignoring event: ${event}`);
    }
  } catch (err) {
    logger.error("clickup_webhook", `Error processing webhook event: ${event}`, {
      data: { error: String(err), task_id },
    });
  }
}

// ─── Status change handler ───────────────────────────────────────────────────
async function handleStatusUpdate(
  clickupTaskId: string,
  historyItems: Array<{ field: string; after?: { status: string } }>
) {
  const statusItem = historyItems.find((h) => h.field === "status");
  if (!statusItem?.after?.status) return;

  const newStatus = statusItem.after.status.toLowerCase();
  const approvedLower = config.clickup.statuses.approved.toLowerCase();

  // We only care about transitions into Approved for the threshold check.
  if (newStatus !== approvedLower) {
    logger.debug("clickup_webhook", `Ignoring status change to "${newStatus}"`);
    return;
  }

  // Skip the per-task fetch entirely — it was timing out intermittently and
  // blocking the approval count. `countApprovedPipelineTasks` already fetches
  // the full list and filters for our embedded-JSON topic tasks, so we can
  // rely on that as the single source of truth. Worst case, a non-pipeline
  // task flipped to Approved doesn't count because it has no embedded JSON.
  logger.info("clickup_webhook", `Task ${clickupTaskId} → Approved — counting approvals`);

  const approvedCount = await countApprovedPipelineTasks();
  const threshold = config.pipeline.approvalThreshold;
  logger.info(
    "clickup_webhook",
    `Approval progress: ${approvedCount}/${threshold}`,
  );

  if (approvedCount >= threshold) {
    logger.info("clickup_webhook", `Threshold reached — firing Tier 2 trigger`);
    await fireTier2Trigger();
  }
}

// ─── Comment posted handler (for "Approved - Needs Tweak") ───────────────────
async function handleCommentPosted(
  clickupTaskId: string,
  historyItems: Array<{ comment?: { text_content: string } }>
) {
  const commentItem = historyItems.find((h) => h.comment?.text_content);
  if (!commentItem?.comment?.text_content) return;
  const humanNotes = commentItem.comment.text_content;

  const task = await fetchTask(clickupTaskId);
  if (!task) return;

  const currentStatus = (task.status?.status ?? "").toLowerCase();
  const needsTweakLower = config.clickup.statuses.approvedWithNotes.toLowerCase();
  if (currentStatus !== needsTweakLower) {
    // Comments on other statuses are just review notes — ignore.
    return;
  }

  const topic = extractEmbeddedTopic(task.description ?? task.text_content ?? "");
  if (!topic) {
    logger.warn(
      "clickup_webhook",
      `Task ${clickupTaskId} in "${currentStatus}" has no embedded topic — cannot refine`,
    );
    return;
  }

  logger.info("clickup_webhook", `Refining "${topic.title}" with human notes`, {
    data: { human_notes: humanNotes },
  });

  const refined = await runTopicRefiner(
    topic,
    humanNotes,
    topic.pipeline_run_id || "ad-hoc",
  );

  const newDescription = buildRefinedDescription(refined, humanNotes);

  await updateTask(clickupTaskId, {
    description: newDescription,
    status: config.clickup.statuses.approved, // auto-advance → fires another webhook
  });

  logger.info(
    "clickup_webhook",
    `Task auto-advanced to Approved after refinement`,
  );
}

function buildRefinedDescription(card: TopicCard, humanNotes: string): string {
  const header = `## 🔄 Topic refined based on your notes

**Refined title:** ${card.title}
**Primary keyword:** ${card.primary_keyword}
**Feature:** ${card.respireLYF_feature}

**Updated rationale**
${card.rationale}

---

### Your notes
> ${humanNotes.replace(/\n/g, "\n> ")}

---

_This task has been auto-advanced to **Approved**. Flip back to Rejected if the refinement misses the mark._
`;

  return header + buildEmbeddedTopicBlock(card);
}
