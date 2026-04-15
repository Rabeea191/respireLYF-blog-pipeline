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

  try {
    // Fire and forget — Vercel cron has a 60s timeout but the pipeline
    // takes longer, so we respond immediately and run async
    res.status(202).json({ message: "Pipeline started", timestamp: new Date().toISOString() });

    // Run pipeline after responding
    await runTier1Pipeline();

  } catch (err) {
    logger.error("cron_trigger", `Pipeline trigger failed: ${String(err)}`);
    // Already responded 202 — just log the error
  }
}
