/**
 * Tier 2 Trigger — POST /api/pipeline/tier2-trigger
 *
 * Fired by the ClickUp webhook once the approval threshold is reached.
 * Loads all Approved topic tasks directly from ClickUp (via embedded JSON
 * in task descriptions), then runs Tier 2 (SEO → brief → write → evaluate
 * → Payload draft) for each.
 *
 * Responds 202 immediately and runs the pipeline asynchronously, because
 * Tier 2 typically takes several minutes per blog and Vercel serverless
 * timeouts are tight.
 *
 * Auth: Bearer CRON_SECRET — same secret used by the weekly cron trigger.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { loadApprovedTopicsFromClickUp, runTier2Pipeline } from "../pipeline/tier2-orchestrator";
import { resetTokenStats, getTokenStats } from "../lib/claude";
import { logger } from "../lib/logger";

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

  // NOTE: Vercel serverless functions terminate as soon as the HTTP response
  // is sent — fire-and-forget doesn't work. Run the full pipeline first and
  // then respond. With 7 approved topics, Tier 2 usually completes within the
  // 300s maxDuration ceiling; if it overruns, bump maxDuration or split the
  // batch across multiple invocations.
  try {
    const approvedTopics = await loadApprovedTopicsFromClickUp();

    if (approvedTopics.length === 0) {
      logger.warn("tier2_trigger", "No approved topics found in ClickUp — nothing to run");
      return res.status(200).json({
        message: "No approved topics found",
        timestamp: new Date().toISOString(),
      });
    }

    logger.info(
      "tier2_trigger",
      `Running Tier 2 for ${approvedTopics.length} approved topic(s)`,
    );
    approvedTopics.forEach((t, i) =>
      logger.info("tier2_trigger", `  ${i + 1}. "${t.title}"`),
    );

    resetTokenStats();
    const results = await runTier2Pipeline(approvedTopics);

    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const cost = getTokenStats();

    logger.info(
      "tier2_trigger",
      `Tier 2 complete — ${passed} passed, ${failed} failed, $${cost.cost_usd} USD`,
    );

    res.status(200).json({
      message: "Tier 2 pipeline complete",
      passed,
      failed,
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
