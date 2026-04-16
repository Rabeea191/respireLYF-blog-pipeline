/**
 * Tier 1 Orchestrator — Weekly Topic Pipeline
 *
 * Triggered by Vercel cron every Monday at 6AM.
 * Also callable manually via POST /api/pipeline/trigger
 *
 * Flow:
 *   1. Create pipeline run record in DB
 *   2. Scrape trends → TrendGate evaluator
 *   3. Save passed signals
 *   4. Topic Generator → TopicGate evaluator (repeat for revise-flagged topics)
 *   5. Save all topic cards to DB
 *   6. Post topic cards to ClickUp for human approval
 *   7. Update pipeline run status → "awaiting_approval"
 *   8. ClickUp webhook (separate handler) picks up human decisions
 *   9. When threshold reached → advance to Tier 2
 */

import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import {
  createPipelineRun,
  updatePipelineRun,
  saveTrendSignals,
  saveTopicCards,
  updateTopicCard,
  getPublishedSlugs,
} from "../lib/store";
import { runTrendScraper } from "../agents/trend-scraper";
import { runTrendGate } from "../evaluators/trend-gate";
import { runTopicGenerator } from "../agents/topic-generator";
import { runTopicGate, buildRegenerationFeedback } from "../evaluators/topic-gate";
import { postTopicsToClickUp } from "../notifications/clickup";
import { config } from "../lib/config";
import type { PipelineRun, PipelineStageLog, TopicCard } from "../types";

// ─── Helper — append a stage log entry ───────────────────────────────────────
function makeLogEntry(
  stage: PipelineStageLog["stage"],
  status: PipelineStageLog["status"],
  opts?: Partial<PipelineStageLog>
): PipelineStageLog {
  return {
    stage,
    status,
    iteration: 0,
    timestamp: new Date().toISOString(),
    ...opts,
  };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────
export async function runTier1Pipeline(): Promise<PipelineRun> {
  const run_id = randomUUID();
  const week_of = getWeekOf();

  logger.info("tier1", `Starting Tier 1 pipeline for week of ${week_of}`, { run_id });

  // ── Create pipeline run record ─────────────────────────────────────────────
  const run = await createPipelineRun({
    week_of,
    status: "running",
    current_stage: "trend_scraping",
    approved_count: 0,
    approval_threshold: config.pipeline.approvalThreshold,
    stage_log: [],
    started_at: new Date().toISOString(),
    topic_cards: [],
  });

  const stageLogs: PipelineStageLog[] = [];

  try {
    // ── Stage 1: Trend Scraping ───────────────────────────────────────────────
    logger.info("tier1", "Stage 1: Trend Scraping", { run_id });
    const scrapeStart = Date.now();
    const rawSignals = await runTrendScraper(run_id);
    const scoredSignals = await runTrendGate(rawSignals, run_id);
    const passedSignals = scoredSignals.filter((s) => s.passed_gate);

    await saveTrendSignals(scoredSignals);

    stageLogs.push(makeLogEntry("trend_scraping", "completed", {
      agent_output_summary: `${rawSignals.length} scraped → ${passedSignals.length} passed gate`,
      duration_ms: Date.now() - scrapeStart,
    }));

    if (passedSignals.length < 5) {
      logger.warn("tier1", `Only ${passedSignals.length} signals passed gate — proceeding anyway`, { run_id });
    }

    await updatePipelineRun(run_id, {
      current_stage: "topic_generation",
      stage_log: stageLogs,
    });

    // ── Stage 2: Topic Generation + Evaluation loop ───────────────────────────
    logger.info("tier1", "Stage 2: Topic Generation", { run_id });

    const publishedSlugs = await getPublishedSlugs();
    let allTopicCards: TopicCard[] = [];
    let generationFeedback: string | undefined;
    let generationIteration = 0;

    while (generationIteration < config.pipeline.maxTopicRetries) {
      const genStart = Date.now();

      // Generate 5 topics
      const rawTopics = await runTopicGenerator(
        scoredSignals,
        publishedSlugs,
        run_id,
        generationIteration,
        generationFeedback
      );

      // Evaluate them
      const evaluatedTopics = await runTopicGate(rawTopics, publishedSlugs, run_id);

      const reviseCount = evaluatedTopics.filter(
        (t) => t.evaluation?.gate_flag === "revise"
      ).length;

      stageLogs.push(makeLogEntry("topic_generation", "completed", {
        iteration: generationIteration,
        agent_output_summary: `${evaluatedTopics.length} topics → ${reviseCount} need revision`,
        duration_ms: Date.now() - genStart,
      }));

      allTopicCards = evaluatedTopics;

      // If 0 topics need revision, we're done
      if (reviseCount === 0) {
        logger.info("tier1", `All topics passed gate on iteration ${generationIteration}`, { run_id });
        break;
      }

      // If this is our last retry, proceed with what we have
      if (generationIteration >= config.pipeline.maxTopicRetries - 1) {
        logger.warn("tier1", `Max retries reached — proceeding with ${reviseCount} revise-flagged topics`, { run_id });
        break;
      }

      // Build feedback and regenerate only the failing topics
      generationFeedback = buildRegenerationFeedback(evaluatedTopics);
      logger.info("tier1", `Regenerating ${reviseCount} topics — iteration ${generationIteration + 1}`, { run_id });
      generationIteration++;
    }

    // ── Stage 3: Save topic cards to DB ──────────────────────────────────────
    await saveTopicCards(allTopicCards);

    await updatePipelineRun(run_id, {
      current_stage: "human_approval",
      stage_log: stageLogs,
      topic_cards: allTopicCards,
    });

    // ── Stage 4: Post to ClickUp for human approval ───────────────────────────
    logger.info("tier1", "Stage 4: Posting to ClickUp", { run_id });

    const taskIdMap = await postTopicsToClickUp(allTopicCards, run);

    // Store ClickUp task IDs on each topic card
    for (const [cardId, taskId] of taskIdMap.entries()) {
      await updateTopicCard(cardId, { clickup_task_id: taskId });
    }

    stageLogs.push(makeLogEntry("human_approval", "running", {
      agent_output_summary: `${taskIdMap.size} tasks posted to ClickUp — awaiting human decisions`,
    }));

    // ── Final: Update run status ──────────────────────────────────────────────
    const finalRun = await updatePipelineRun(run_id, {
      status: "awaiting_approval",
      current_stage: "human_approval",
      stage_log: stageLogs,
    });

    logger.info("tier1", `Tier 1 complete — run ${run_id} awaiting human approval`, { run_id });

    return { ...run, status: "awaiting_approval", stage_log: stageLogs };

  } catch (err) {
    logger.error("tier1", `Pipeline failed: ${String(err)}`, { run_id });

    stageLogs.push(makeLogEntry("trend_scraping", "failed", {
      error: String(err),
    }));

    await updatePipelineRun(run_id, {
      status: "failed",
      stage_log: stageLogs,
    });

    throw err;
  }
}

// ─── Helper: get Monday of current week in YYYY-MM-DD ────────────────────────
function getWeekOf(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split("T")[0];
}

// ─── Run directly ─────────────────────────────────────────────────────────────
runTier1Pipeline()
  .then((run) => {
    console.log(`\n✅ Tier 1 complete — run ID: ${run.id}`);
    console.log(`   Status: ${run.status}`);
    console.log(`   Topics: ${run.topic_cards?.length ?? 0}`);
    console.log(`\n   Check ClickUp — topics should appear in "Blog Topic Review" list!`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ Tier 1 failed:", err.message);
    process.exit(1);
  });
