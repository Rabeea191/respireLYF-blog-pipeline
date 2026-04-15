/**
 * ClickUp Webhook Handler
 *
 * ClickUp fires a POST to this endpoint whenever a task status changes.
 * We look for our topic-review tasks and route the decision back into
 * the pipeline approval state machine.
 *
 * Deploy as: /api/pipeline/clickup-webhook
 * Register at: ClickUp Settings → Integrations → Webhooks → taskStatusUpdated
 *
 * Webhook events we handle:
 *   taskStatusUpdated — human changed the task status
 *   taskCommentPosted — human added notes (for "Approved with Notes" flow)
 */

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { db, getTopicCard, updateTopicCard, updatePipelineRun, getTopicsByRun } from "../lib/supabase";
import { runTopicRefiner } from "../agents/topic-refiner";
import type { ApprovalStatus } from "../types";

// ─── Verify ClickUp webhook signature ────────────────────────────────────────
function verifySignature(req: NextApiRequest, rawBody: string): boolean {
  if (!config.clickup.webhookSecret) return true; // Skip if not configured
  const signature = req.headers["x-signature"] as string;
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", config.clickup.webhookSecret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Map ClickUp status → pipeline ApprovalStatus ────────────────────────────
function mapStatus(clickupStatus: string): ApprovalStatus | null {
  const lower = clickupStatus.toLowerCase().trim();
  const statuses = config.clickup.statuses;

  if (lower === statuses.approved.toLowerCase())           return "approved";
  if (lower === statuses.approvedWithNotes.toLowerCase())  return "approved_with_notes";
  if (lower === statuses.rejected.toLowerCase())           return "rejected";
  return null; // Unknown status — ignore
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify signature
  const rawBody = JSON.stringify(req.body);
  if (!verifySignature(req, rawBody)) {
    logger.warn("clickup_webhook", "Invalid webhook signature — rejected");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { event, task_id, history_items } = req.body as {
    event: string;
    task_id: string;
    history_items?: Array<{ field: string; after?: { status: string }; comment?: { text_content: string } }>;
  };

  // Acknowledge immediately — ClickUp expects 200 within 5s
  res.status(200).json({ received: true });

  try {
    if (event === "taskStatusUpdated") {
      await handleStatusUpdate(task_id, history_items ?? []);
    } else if (event === "taskCommentPosted") {
      await handleCommentPosted(task_id, history_items ?? []);
    }
  } catch (err) {
    logger.error("clickup_webhook", `Error processing webhook event: ${event}`, {
      data: { error: String(err), task_id },
    });
  }
}

// ─── Status change handler ────────────────────────────────────────────────────
async function handleStatusUpdate(
  clickupTaskId: string,
  historyItems: Array<{ field: string; after?: { status: string } }>
) {
  // Find the status change item
  const statusItem = historyItems.find((h) => h.field === "status");
  if (!statusItem?.after?.status) return;

  const newStatus = statusItem.after.status;
  const approvalStatus = mapStatus(newStatus);
  if (!approvalStatus) {
    logger.debug("clickup_webhook", `Ignoring status change to "${newStatus}" — not an approval status`);
    return;
  }

  // Find the topic card by ClickUp task ID
  const { data: cards } = await db
    .from("topic_cards")
    .select("*")
    .eq("clickup_task_id", clickupTaskId)
    .limit(1);

  if (!cards || cards.length === 0) {
    logger.warn("clickup_webhook", `No topic card found for ClickUp task ${clickupTaskId}`);
    return;
  }

  const card = cards[0];
  logger.info("clickup_webhook", `Topic "${card.title}" → ${approvalStatus}`, {
    data: { clickup_task_id: clickupTaskId },
  });

  // Update the topic card
  await updateTopicCard(card.id, {
    approval_status: approvalStatus,
  });

  // If approved (no notes needed), check if we've hit the threshold
  if (approvalStatus === "approved") {
    await checkApprovalThreshold(card.pipeline_run_id);
  }

  // If rejected, trigger regeneration
  if (approvalStatus === "rejected") {
    await triggerTopicRegeneration(card.pipeline_run_id, card.id);
  }
}

// ─── Comment posted handler (captures human notes for "approved with notes") ──
async function handleCommentPosted(
  clickupTaskId: string,
  historyItems: Array<{ comment?: { text_content: string } }>
) {
  const commentItem = historyItems.find((h) => h.comment?.text_content);
  if (!commentItem?.comment?.text_content) return;

  const humanNotes = commentItem.comment.text_content;

  // Find the topic card
  const { data: cards } = await db
    .from("topic_cards")
    .select("*")
    .eq("clickup_task_id", clickupTaskId)
    .limit(1);

  if (!cards || cards.length === 0) return;

  const card = cards[0];

  // Only process if status is "approved_with_notes"
  if (card.approval_status !== "approved_with_notes") return;

  logger.info("clickup_webhook", `Running Topic Refiner for "${card.title}"`, {
    data: { human_notes: humanNotes },
  });

  // Run refiner with human notes
  const refined = await runTopicRefiner(card, humanNotes, card.pipeline_run_id);

  // Save refined card
  await updateTopicCard(card.id, {
    title:              refined.title,
    primary_keyword:    refined.primary_keyword,
    rationale:          refined.rationale,
    respireLYF_feature: refined.respireLYF_feature,
    human_notes:        humanNotes,
    refined_at:         refined.refined_at,
    iteration_count:    refined.iteration_count,
    // Mark as fully approved after refinement
    approval_status:    "approved",
  });

  // Check threshold after successful refinement
  await checkApprovalThreshold(card.pipeline_run_id);
}

// ─── Check if we've hit the approval threshold ────────────────────────────────
async function checkApprovalThreshold(runId: string) {
  const allCards = await getTopicsByRun(runId);
  const approvedCount = allCards.filter(
    (c) => c.approval_status === "approved"
  ).length;

  logger.info("clickup_webhook", `Approval progress: ${approvedCount}/${config.pipeline.approvalThreshold}`, {
    run_id: runId,
  });

  await updatePipelineRun(runId, { approved_count: approvedCount });

  if (approvedCount >= config.pipeline.approvalThreshold) {
    logger.info("clickup_webhook", `Threshold reached! Advancing pipeline to Tier 2`, { run_id: runId });
    await updatePipelineRun(runId, {
      status: "approved",
      current_stage: "seo_research",
    });
    // Tier 2 orchestrator picks up from here (polls for status === "approved")
  }
}

// ─── Trigger regeneration for a rejected topic ────────────────────────────────
async function triggerTopicRegeneration(runId: string, rejectedCardId: string) {
  logger.info("clickup_webhook", `Queuing topic regeneration for run ${runId}`, {
    data: { rejected_card_id: rejectedCardId },
  });

  // Mark the run as needing regeneration
  await updatePipelineRun(runId, {
    status: "running",
    current_stage: "topic_generation",
  });
  // The Tier 1 orchestrator polling loop will pick this up and re-run generation
}
