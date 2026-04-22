/**
 * Tier 2 Trigger — POST /api/pipeline/tier2-trigger
 *
 * Fired by the ClickUp webhook once the approval threshold is reached.
 * Loads all Approved topic tasks directly from ClickUp (via embedded JSON
 * in task descriptions) that haven't yet been tier2_processed, and runs
 * Tier 2 (SEO → brief → write → evaluate → Payload draft).
 *
 * ─── Self-chaining for Vercel 300s limit ─────────────────────────────────
 * One blog takes ~2-3 min. 8 blogs in one invocation would blow 300s.
 * So this endpoint processes ONE topic per invocation, then fires itself
 * via a fire-and-forget HTTP call to process the next. Each topic is
 * marked tier2_processed_at in ClickUp so the chain naturally stops when
 * no unprocessed approved topics remain.
 *
 * Auth: Bearer CRON_SECRET — same secret used by the weekly cron trigger.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import {
  loadApprovedTopicsFromClickUp,
  runTier2Pipeline,
} from "../pipeline/tier2-orchestrator";
import { resetTokenStats, getTokenStats } from "../lib/claude";
import { logger } from "../lib/logger";

function resolveBaseUrl(): string {
  if (process.env.PIPELINE_BASE_URL) return process.env.PIPELINE_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** Fire the next tier2-trigger invocation without awaiting its completion. */
async function fireNextInvocation(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/pipeline/tier2-trigger`;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error(
      "tier2_trigger",
      "CRON_SECRET missing — cannot fire chained invocation",
    );
    return;
  }

  logger.info("tier2_trigger", `Firing chained invocation → ${url}`);
  try {
    // Very short timeout — the callee won't respond until its single topic
    // is processed (~3 min), and we don't want to wait for that here. We
    // just need the HTTP request to be DISPATCHED; an intentional timeout
    // is the normal exit path.
    await axios.post(url, {}, {
      headers: { Authorization: `Bearer ${cronSecret}` },
      timeout: 5_000,
    });
  } catch (err: any) {
    const code = err?.code;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
      // Expected — request sent, callee is busy processing its topic.
      return;
    }
    logger.warn(
      "tier2_trigger",
      `Chained invocation call returned unexpected result: ${err?.response?.status ?? err.message}`,
    );
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    logger.warn("tier2_trigger", "Unauthorised trigger attempt");
    return res.status(401).json({ error: "Unauthorised" });
  }

  logger.info("tier2_trigger", "Trigger received — loading approved topics from ClickUp");

  try {
    const approvedTopics = await loadApprovedTopicsFromClickUp();

    if (approvedTopics.length === 0) {
      logger.info(
        "tier2_trigger",
        "No unprocessed approved topics — chain complete",
      );
      return res.status(200).json({
        message: "No unprocessed approved topics — chain complete",
        timestamp: new Date().toISOString(),
      });
    }

    // Process ONE topic per invocation to stay under the 300s Vercel limit.
    const topic = approvedTopics[0];
    const remaining = approvedTopics.length - 1;

    logger.info(
      "tier2_trigger",
      `Processing 1 of ${approvedTopics.length} approved topic(s): "${topic.title}" (${remaining} remaining after this)`,
    );

    resetTokenStats();
    const results = await runTier2Pipeline([topic]);

    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const cost = getTokenStats();

    logger.info(
      "tier2_trigger",
      `Topic done — passed: ${passed}, failed: ${failed}, $${cost.cost_usd} USD`,
    );

    // If more topics remain, fire the next invocation before responding.
    // Fire-and-dispatch: we just need ONE HTTP request to go out; our
    // short client-side timeout will fire and we'll return. Vercel keeps
    // the callee alive because Vercel received the request.
    if (remaining > 0) {
      await fireNextInvocation();
    } else {
      logger.info("tier2_trigger", "All approved topics processed — chain done");
    }

    res.status(200).json({
      message: "Tier 2 invocation complete",
      processed: topic.title,
      passed,
      failed,
      remaining,
      cost_usd: cost.cost_usd,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.error("tier2_trigger", `Tier 2 run failed: ${err.message}`);
    res.status(500).json({
      error: "Tier 2 failed",
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
}
