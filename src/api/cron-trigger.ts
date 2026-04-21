/**
 * Vercel Cron Endpoint — POST /api/pipeline/trigger
 *
 * Vercel calls this every Monday at 6AM (configured in vercel.json).
 * Can also be called manually with the correct secret for testing.
 *
 * Security: Vercel cron requests include a secret header automatically.
 * Manual calls require the same secret in Authorization header.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { runTier1Pipeline } from "../pipeline/tier1-orchestrator";
import { logger } from "../lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify the cron secret (Vercel sets this automatically for cron jobs)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    logger.warn("cron_trigger", "Unauthorised trigger attempt");
    return res.status(401).json({ error: "Unauthorised" });
  }

  logger.info("cron_trigger", "Pipeline triggered — starting Tier 1");

  // NOTE: Vercel serverless functions terminate as soon as the HTTP response
  // is sent, so we can't use a fire-and-forget pattern. Run the pipeline
  // to completion first, then respond. Function maxDuration is 300s which
  // is comfortably above the ~2-3 min the pipeline needs in practice.
  try {
    const run = await runTier1Pipeline();
    res.status(200).json({
      message: "Pipeline complete",
      run_id: run.id,
      topic_count: run.topic_cards?.length ?? 0,
      status: run.status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("cron_trigger", `Pipeline trigger failed: ${String(err)}`);
    res.status(500).json({
      error: "Pipeline failed",
      message: String(err),
      timestamp: new Date().toISOString(),
    });
  }
}
