/**
 * Tier 2 Reset — POST /api/pipeline/tier2-reset
 *
 * Clears the `tier2_processed_at` marker on every Approved ClickUp topic
 * task so the next tier2-trigger invocation will pick them up again.
 *
 * Use this after fixing CMS credentials or any other systemic issue that
 * caused topics to be marked processed without a real Payload draft.
 *
 * Auth: Bearer CRON_SECRET.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import {
  extractEmbeddedTopic,
  buildEmbeddedTopicBlock,
  TOPIC_BLOCK_OPEN,
} from "../lib/topic-embed";
import type { TopicCard } from "../types";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    logger.warn("tier2_reset", "Unauthorised reset attempt");
    return res.status(401).json({ error: "Unauthorised" });
  }

  const headers = {
    Authorization: config.clickup.apiKey,
    "Content-Type": "application/json",
  };

  try {
    logger.info("tier2_reset", "Fetching tasks from ClickUp list");
    const { data } = await axios.get(
      `${CLICKUP_BASE}/list/${config.clickup.listId}/task`,
      {
        headers,
        params: { include_closed: false, subtasks: false, page: 0 },
        timeout: 30_000,
      },
    );

    const tasks: Array<{
      id: string;
      name?: string;
      status?: { status: string };
      description?: string;
      text_content?: string;
    }> = data?.tasks ?? [];

    const approvedLower = config.clickup.statuses.approved.toLowerCase();
    const notesLower    = config.clickup.statuses.approvedWithNotes.toLowerCase();

    const resetTitles: string[] = [];
    const skippedReasons: Record<string, number> = {};

    for (const task of tasks) {
      const status = (task.status?.status ?? "").toLowerCase();
      if (status !== approvedLower && status !== notesLower) {
        skippedReasons["not_approved"] = (skippedReasons["not_approved"] ?? 0) + 1;
        continue;
      }

      const rawDescription = task.description ?? task.text_content ?? "";
      const topic = extractEmbeddedTopic(rawDescription);
      if (!topic) {
        skippedReasons["no_embedded_topic"] = (skippedReasons["no_embedded_topic"] ?? 0) + 1;
        continue;
      }
      if (!topic.tier2_processed_at) {
        skippedReasons["not_yet_processed"] = (skippedReasons["not_yet_processed"] ?? 0) + 1;
        continue;
      }

      const cleanTopic: TopicCard = { ...topic };
      delete cleanTopic.tier2_processed_at;

      const blockStart = rawDescription.indexOf(TOPIC_BLOCK_OPEN);
      const beforeBlock = blockStart === -1 ? rawDescription : rawDescription.slice(0, blockStart);
      const newDescription = beforeBlock.trimEnd() + buildEmbeddedTopicBlock(cleanTopic);

      try {
        await axios.put(
          `${CLICKUP_BASE}/task/${task.id}`,
          { description: newDescription },
          { headers, timeout: 15_000 },
        );
        resetTitles.push(topic.title);
        logger.info("tier2_reset", `Reset ${task.id}: "${topic.title}"`);
      } catch (err: any) {
        logger.warn("tier2_reset", `Failed to reset ${task.id}: ${err.message}`);
        skippedReasons["update_failed"] = (skippedReasons["update_failed"] ?? 0) + 1;
      }
    }

    res.status(200).json({
      message: "Reset complete",
      reset_count: resetTitles.length,
      reset_titles: resetTitles,
      skipped: skippedReasons,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.error("tier2_reset", `Reset failed: ${err.message}`);
    res.status(500).json({
      error: "Reset failed",
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
}
