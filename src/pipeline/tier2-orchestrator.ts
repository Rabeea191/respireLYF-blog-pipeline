/**
 * Tier 2 Orchestrator — SEO → Brief → Write → Evaluate → Post
 *
 * Runs after Tier 1 (trend → topics → human approval).
 * Takes approved TopicCards and runs them through:
 *
 *   Stage 6: SEO Research
 *   Stage 7: Content Brief
 *   Stage 9: Blog Writer (+ Stage 10 evaluator loop, max 3 iterations)
 *   Stage 11: Payload CMS Post (as draft for human review)
 *
 * Each stage has its own mini evaluator gate.
 * Stage 9/10 run in a writer ↔ evaluator loop (max 3 iterations).
 *
 * On completion: one blog draft per approved topic is visible in Payload admin.
 */

import axios                 from "axios";
import { runSEOResearcher }  from "../agents/seo-researcher";
import { runContentBrief }   from "../agents/content-brief";
import { runBlogWriter }     from "../agents/blog-writer";
import { runBlogEvaluator }  from "../evaluators/blog-gate";
import { runPayloadPoster }  from "../agents/payload-poster";
import { logger }            from "../lib/logger";
import { config }            from "../lib/config";
import * as fs               from "fs";
import * as path             from "path";
import type {
  TopicCard,
  SEOPackage,
  ContentBrief,
  BlogDraft,
  PipelineStageLog,
} from "../types";

const MAX_WRITE_ITERATIONS = 3;

export interface Tier2Result {
  topic_id:    string;
  topic_title: string;
  success:     boolean;
  stage_log:   PipelineStageLog[];
  payload_draft_url?: string;
  slug?:       string;
  error?:      string;
}

// ─── Process one approved topic through Tier 2 ────────────────────────────
async function processTopic(topic: TopicCard): Promise<Tier2Result> {
  const log: PipelineStageLog[] = [];
  const now = () => new Date().toISOString();

  function addLog(
    stage: PipelineStageLog["stage"],
    status: PipelineStageLog["status"],
    iteration: number,
    extra: Partial<PipelineStageLog> = {}
  ) {
    log.push({ stage, status, iteration, timestamp: now(), ...extra });
  }

  logger.info("tier2", `▶ Processing topic: "${topic.title}"`);

  // ── Stage 6: SEO Research ──────────────────────────────────────────────
  addLog("seo_research", "running", 1);
  const seoResult = await runSEOResearcher(topic);

  if (!seoResult.success || !seoResult.data) {
    addLog("seo_research", "failed", 1, {
      error: seoResult.error,
      duration_ms: seoResult.duration_ms,
    });
    return { topic_id: topic.id, topic_title: topic.title, success: false, stage_log: log, error: `SEO research failed: ${seoResult.error}` };
  }

  const seo: SEOPackage = seoResult.data;
  addLog("seo_research", "completed", 1, {
    agent_output_summary: `${seo.secondary_keywords.length} secondary keywords, ${seo.suggested_h2_outline.length} H2s, ${seo.competitor_urls.length} competitors`,
    duration_ms: seoResult.duration_ms,
  });

  // ── Stage 7: Content Brief ────────────────────────────────────────────
  addLog("content_brief", "running", 1);
  const briefResult = await runContentBrief(topic, seo);

  if (!briefResult.success || !briefResult.data) {
    addLog("content_brief", "failed", 1, { error: briefResult.error, duration_ms: briefResult.duration_ms });
    return { topic_id: topic.id, topic_title: topic.title, success: false, stage_log: log, error: `Content brief failed: ${briefResult.error}` };
  }

  const brief: ContentBrief = briefResult.data;
  addLog("content_brief", "completed", 1, {
    agent_output_summary: `Slug: ${brief.yaml_frontmatter.slug}, ${brief.h2_outline.length} H2s, YMYL: ${brief.ymyl_section_required}`,
    duration_ms: briefResult.duration_ms,
  });

  // ── Stages 9 + 10: Writer ↔ Evaluator Loop ────────────────────────────
  let writeIteration = 1;
  let lastFeedback: string | undefined;
  let approvedDraft: BlogDraft | null = null;

  while (writeIteration <= MAX_WRITE_ITERATIONS) {
    // Stage 9: Write
    addLog("blog_writing", "running", writeIteration);
    const writeResult = await runBlogWriter(topic, seo, brief, lastFeedback);
    const draft = writeResult.data;

    if (!draft) {
      addLog("blog_writing", "failed", writeIteration, {
        error: writeResult.error,
        duration_ms: writeResult.duration_ms,
      });
      break;
    }

    addLog("blog_writing", "completed", writeIteration, {
      agent_output_summary: `${draft.word_count} words, iteration ${writeIteration}`,
      duration_ms: writeResult.duration_ms,
    });

    // Stage 10: Evaluate
    addLog("blog_evaluation", "running", writeIteration);
    const evalResult = await runBlogEvaluator(draft, brief, seo);
    const evaluation = evalResult.data;

    if (!evaluation) {
      addLog("blog_evaluation", "failed", writeIteration, { error: evalResult.error, duration_ms: evalResult.duration_ms });
      break;
    }

    addLog("blog_evaluation", evaluation.passed ? "completed" : "failed", writeIteration, {
      evaluator_result: evaluation.passed
        ? `✅ Passed — soft ${evaluation.soft_scores.total}/30`
        : `❌ ${evaluation.hard_fails.length} hard fails, soft ${evaluation.soft_scores.total}/30`,
      duration_ms: evalResult.duration_ms,
    });

    if (evaluation.passed) {
      approvedDraft = { ...draft, evaluation };
      break;
    }

    // Failed — pass feedback to next writer iteration
    lastFeedback = evaluation.feedback_for_writer;
    writeIteration++;

    if (writeIteration <= MAX_WRITE_ITERATIONS) {
      logger.info("tier2", `Writer iteration ${writeIteration - 1} failed — retrying with evaluator feedback`);
    }
  }

  // Escalate if no approved draft
  if (!approvedDraft) {
    logger.error("tier2", `Topic "${topic.title}" failed all ${MAX_WRITE_ITERATIONS} write iterations — escalating to human`);
    return {
      topic_id:    topic.id,
      topic_title: topic.title,
      success:     false,
      stage_log:   log,
      error:       `Blog writing failed after ${MAX_WRITE_ITERATIONS} iterations — human review required`,
    };
  }

  // ── Stage 11: Post to Payload CMS ─────────────────────────────────────
  addLog("html_formatting", "running", 1);
  const postResult = await runPayloadPoster(approvedDraft, brief);

  if (!postResult.success || !postResult.data) {
    addLog("html_formatting", "failed", 1, { error: postResult.error, duration_ms: postResult.duration_ms });
    // Non-fatal — draft is still saved to disk
    logger.warn("tier2", `Payload post failed for "${topic.title}" — draft saved locally at ${approvedDraft.file_path}`);
    return {
      topic_id:    topic.id,
      topic_title: topic.title,
      success:     true, // partial success — draft exists
      stage_log:   log,
      slug:        brief.yaml_frontmatter.slug,
      error:       `Payload post failed: ${postResult.error} — draft at ${approvedDraft.file_path}`,
    };
  }

  addLog("html_formatting", "completed", 1, {
    agent_output_summary: `Draft posted: ${postResult.data.adminUrl}`,
    duration_ms: postResult.duration_ms,
  });

  addLog("human_review", "running", 1, {
    agent_output_summary: `Awaiting human review at ${postResult.data.adminUrl}`,
  });

  logger.info("tier2", `✅ "${topic.title}" → draft at ${postResult.data.adminUrl}`);

  return {
    topic_id:           topic.id,
    topic_title:        topic.title,
    success:            true,
    stage_log:          log,
    payload_draft_url:  postResult.data.adminUrl,
    slug:               brief.yaml_frontmatter.slug,
  };
}

// ─── Fetch approved topic IDs from ClickUp ───────────────────────────────
async function getApprovedTopicsFromClickUp(): Promise<TopicCard[]> {
  // Load local topics from store
  const dataDir = path.join(process.cwd(), "pipeline-data");
  const topicsFile = path.join(dataDir, "latest-topics.json");

  if (!fs.existsSync(topicsFile)) {
    throw new Error("No topics found — run `npm run tier1` first");
  }

  const allTopics: TopicCard[] = JSON.parse(fs.readFileSync(topicsFile, "utf-8"));
  logger.info("tier2", `Loaded ${allTopics.length} topics from local store`);

  const approvedTopics: TopicCard[] = [];
  const approvedStatusLower = config.clickup.statuses.approved.toLowerCase();
  const approvedNotesLower  = config.clickup.statuses.approvedWithNotes.toLowerCase();

  for (const topic of allTopics) {
    if (!topic.clickup_task_id) {
      logger.warn("tier2", `Topic "${topic.title}" has no ClickUp task ID — skipping`);
      continue;
    }

    try {
      const { data } = await axios.get(
        `https://api.clickup.com/api/v2/task/${topic.clickup_task_id}`,
        {
          headers: { Authorization: config.clickup.apiKey },
          timeout: 10_000,
        }
      );

      const status: string = (data?.status?.status ?? "").toLowerCase();
      logger.info("tier2", `"${topic.title}" → ClickUp status: "${status}"`);

      if (status.includes("approved") || status === approvedStatusLower || status === approvedNotesLower) {
        approvedTopics.push({
          ...topic,
          approval_status: status.includes("notes") ? "approved_with_notes" : "approved",
          human_notes: data?.description ?? topic.human_notes,
        });
      }
    } catch (err: any) {
      logger.warn("tier2", `Could not fetch ClickUp task ${topic.clickup_task_id}: ${err.message}`);
    }
  }

  return approvedTopics;
}

// ─── Run Tier 2 for all approved topics ───────────────────────────────────
export async function runTier2Pipeline(approvedTopics: TopicCard[]): Promise<Tier2Result[]> {
  logger.info("tier2", `Starting Tier 2 for ${approvedTopics.length} approved topics`);

  const results: Tier2Result[] = [];

  // Process sequentially to avoid rate limiting Claude API
  for (const topic of approvedTopics) {
    try {
      const result = await processTopic(topic);
      results.push(result);
      logger.info("tier2", `Topic "${topic.title}": ${result.success ? "✅" : "❌"}`);
    } catch (err: any) {
      logger.error("tier2", `Unexpected error for "${topic.title}": ${err.message}`);
      results.push({
        topic_id:    topic.id,
        topic_title: topic.title,
        success:     false,
        stage_log:   [],
        error:       err.message,
      });
    }
  }

  const passed  = results.filter((r) => r.success).length;
  const failed  = results.filter((r) => !r.success).length;
  logger.info("tier2", `Tier 2 complete — ${passed} passed, ${failed} failed`);

  return results;
}

// ─── Main entry point ─────────────────────────────────────────────────────
async function main() {
  logger.info("tier2", "=== Tier 2 Pipeline Starting ===");

  // Check for --all flag (bypass ClickUp check — run all local topics)
  const runAll = process.argv.includes("--all");

  let approvedTopics: TopicCard[];

  if (runAll) {
    logger.info("tier2", "--all flag set: treating all local topics as approved");
    const dataDir = path.join(process.cwd(), "pipeline-data");
    const topicsFile = path.join(dataDir, "latest-topics.json");
    if (!fs.existsSync(topicsFile)) {
      logger.error("tier2", "No topics found — run `npm run tier1` first");
      process.exit(1);
    }
    approvedTopics = JSON.parse(fs.readFileSync(topicsFile, "utf-8"));
  } else {
    logger.info("tier2", "Checking ClickUp for approved topics…");
    approvedTopics = await getApprovedTopicsFromClickUp();
  }

  if (approvedTopics.length === 0) {
    logger.warn("tier2", "No approved topics found — approve topics in ClickUp first, then re-run");
    logger.warn("tier2", "Tip: or run `npm run tier2 -- --all` to process all topics");
    process.exit(0);
  }

  logger.info("tier2", `Found ${approvedTopics.length} approved topics — starting blog production`);
  approvedTopics.forEach((t, i) => logger.info("tier2", `  ${i + 1}. "${t.title}"`));

  const results = await runTier2Pipeline(approvedTopics);

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log("\n════════════════════════════════════════");
  console.log(`✅  Tier 2 complete — ${passed} blogs produced, ${failed} failed`);
  console.log("════════════════════════════════════════");

  results.forEach((r) => {
    if (r.success) {
      console.log(`  ✅  "${r.topic_title}"`);
      if (r.payload_draft_url) console.log(`       Payload draft: ${r.payload_draft_url}`);
      if (r.slug) console.log(`       Slug: ${r.slug}`);
    } else {
      console.log(`  ❌  "${r.topic_title}" — ${r.error}`);
    }
  });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n❌ Tier 2 fatal error:", err.message);
  process.exit(1);
});
