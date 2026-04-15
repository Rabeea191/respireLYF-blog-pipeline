/**
 * Tier 1 — Topic Generator Agent
 *
 * Takes top passed TrendSignals + published slug archive and produces
 * exactly 5 topic candidates for the week.
 *
 * Rules enforced:
 *   - Title under 60 chars
 *   - Primary keyword is patient-language (not internal brand vocabulary)
 *   - Feature mapping from blog2.md applied
 *   - No duplicate slugs against existing published blogs
 *   - YMYL flag set for any symptom/flare/worsening topic
 */

import { callClaudeJSON } from "../lib/claude";
import { logger } from "../lib/logger";
import type { TopicCard, TrendSignal, RespireLYFFeature } from "../types";
import { randomUUID } from "crypto";

const FEATURE_MAP: Record<string, RespireLYFFeature> = {
  sleep:       "Sleep HD tracking + peak flow correlation",
  food:        "Food HD + MD-RIC pattern detection",
  diet:        "Food HD + MD-RIC pattern detection",
  stress:      "Stress HD + Breathing Score",
  weather:     "Weather & Environment HD (auto-tracked)",
  cold:        "Weather & Environment HD (auto-tracked)",
  environment: "Weather & Environment HD (auto-tracked)",
  cough:       "Passive cough tracking (wet/dry, on-device ML)",
  "peak flow": "Peak Flow HI + trend visualization",
  inhaler:     "Inhaler technique detection via Apple Watch",
  supplement:  "LYF Hub supplement recommendations",
  hydration:   "Hydration HD",
  water:       "Hydration HD",
  exercise:    "Activity HD + Breathing Score",
  activity:    "Activity HD + Breathing Score",
};

const BANNED_WORDS = [
  "journey", "empower", "transform", "game-changer",
  "revolutionary", "unlock", "leverage", "synergy",
];

const SYSTEM_PROMPT = `You are the Topic Generator for RespireLYF — an AI-powered respiratory health management app for US adults living with asthma or COPD.

Your job: given a list of trending signals and an archive of already-published blog slugs, generate exactly 5 distinct, high-quality blog topic candidates for this week.

BRAND CONTEXT:
- RespireLYF tracks 10 Health Determinants (medications, food, hydration, weather, sleep, activity, stress) and 5 Health Indicators (cough, breathing score, peak flow, ACT/CAT surveys, vitals)
- Core differentiator: MD-RIC — an AI co-pilot that learns each patient's personal Breathing Fingerprint
- iOS only app (iPhone + Apple Watch)
- Target audience: US adults with asthma or COPD, frustrated by guessing why their breathing fluctuates

TOPIC GENERATION RULES:
1. Title must be under 60 characters — patient-language, keyword-heavy, no brand fluff
2. Primary keyword must be an exact phrase a patient would Google (never internal brand vocab like "multi-determinant tracking" or "respiratory intelligence")
3. Each topic must map to exactly ONE RespireLYF feature (see feature list below)
4. No two topics can target the same primary keyword or feature
5. YMYL flag = true for any topic covering symptoms, flares, worsening conditions, or anything involving clinical thresholds
6. Rationale must name the specific trend signal that inspired it + why this week
7. Topics must be clearly distinct from each other in angle and audience pain point

BANNED WORDS (never appear in title or rationale): journey, empower, transform, game-changer, revolutionary, unlock

FEATURE LIST (use these exact strings):
- "Sleep HD tracking + peak flow correlation"
- "Food HD + MD-RIC pattern detection"
- "Stress HD + Breathing Score"
- "Weather & Environment HD (auto-tracked)"
- "Passive cough tracking (wet/dry, on-device ML)"
- "Peak Flow HI + trend visualization"
- "Inhaler technique detection via Apple Watch"
- "Breathing Fingerprint + MD-RIC daily MEEPs"
- "LYF Hub supplement recommendations"
- "Hydration HD"
- "Activity HD + Breathing Score"

TOPIC TYPES (pick the most accurate):
- "trigger_pattern" — what causes or worsens respiratory symptoms
- "copd_specific" — COPD-focused (not asthma)
- "tracking_management" — how to track, measure, understand data
- "cough_specific" — cough patterns, types, causes
- "lifestyle_factor" — sleep, food, stress, hydration, exercise

OUTPUT: Return a JSON array of exactly 5 topic objects.`;

interface RawTopicOutput {
  title: string;
  primary_keyword: string;
  rationale: string;
  respireLYF_feature: RespireLYFFeature;
  intent_strength: "high" | "medium" | "low";
  topic_type: string;
  ymyl_flag: boolean;
}

export async function runTopicGenerator(
  signals: TrendSignal[],
  publishedSlugs: string[],
  run_id: string,
  iteration = 0,
  previousFeedback?: string
): Promise<TopicCard[]> {
  const passedSignals = signals.filter((s) => s.passed_gate).slice(0, 15);

  logger.info("topic_generator", `Generating topics from ${passedSignals.length} signals`, {
    run_id,
    iteration,
  });

  const userPrompt = `
TRENDING SIGNALS THIS WEEK (use these as inspiration):
${JSON.stringify(passedSignals.map(s => ({
  query: s.raw_query,
  source: s.source.name,
  direction: s.trend_direction,
  seasonal: s.seasonal_context_tag,
  score: s.gate_scores?.total,
})), null, 2)}

ALREADY PUBLISHED SLUGS (do not duplicate these topics):
${publishedSlugs.join("\n")}

${previousFeedback ? `PREVIOUS ATTEMPT FEEDBACK (fix these issues):\n${previousFeedback}\n` : ""}

Generate exactly 5 topic candidates. Return only the JSON array.`;

  const raw = await callClaudeJSON<RawTopicOutput[]>({
    stage: "topic_generator",
    run_id,
    system: SYSTEM_PROMPT,
    user: userPrompt,
    temperature: 0.4,
    iteration,
    schema_hint: `Array of 5: { title, primary_keyword, rationale, respireLYF_feature, intent_strength, topic_type, ymyl_flag }`,
  });

  const results = Array.isArray(raw) ? raw : [];

  // Map raw output → TopicCard, enforce hard constraints locally
  const cards: TopicCard[] = results.slice(0, 5).map((r) => {
    const slug = r.primary_keyword
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80);

    // Truncate title to 60 chars if Claude exceeded it
    const title = r.title.length > 60 ? r.title.slice(0, 57) + "..." : r.title;

    return {
      id: randomUUID(),
      pipeline_run_id: run_id,
      title,
      primary_keyword: r.primary_keyword,
      rationale: r.rationale,
      respireLYF_feature: r.respireLYF_feature,
      intent_strength: r.intent_strength,
      topic_type: r.topic_type as TopicCard["topic_type"],
      ymyl_flag: r.ymyl_flag,
      source_signal_ids: passedSignals.slice(0, 3).map((s) => s.id),
      generated_at: new Date().toISOString(),
      iteration_count: iteration,
      approval_status: "pending",
    };
  });

  logger.info("topic_generator", `Generated ${cards.length} topic cards`, { run_id, iteration });
  return cards;
}

/**
 * Validates a topic card against hard format rules.
 * Returns array of violation messages (empty = pass).
 */
export function validateTopicCard(card: TopicCard, publishedSlugs: string[]): string[] {
  const violations: string[] = [];

  if (card.title.length > 60) {
    violations.push(`Title too long: ${card.title.length} chars (max 60)`);
  }

  if (!card.respireLYF_feature) {
    violations.push("Missing respireLYF_feature mapping");
  }

  const slug = card.primary_keyword.toLowerCase().replace(/\s+/g, "-");
  if (publishedSlugs.some((s) => s.includes(slug.slice(0, 30)))) {
    violations.push(`Duplicate topic — slug '${slug}' matches existing published blog`);
  }

  // Check for brand vocabulary in primary keyword
  const brandVocab = ["multi-determinant", "respiratory intelligence", "breathing fingerprint", "md-ric", "health indicator", "health determinant"];
  if (brandVocab.some((v) => card.primary_keyword.toLowerCase().includes(v))) {
    violations.push(`Primary keyword uses internal brand vocabulary: "${card.primary_keyword}"`);
  }

  // Check banned words
  const fullText = `${card.title} ${card.rationale}`.toLowerCase();
  BANNED_WORDS.forEach((w) => {
    if (fullText.includes(w)) violations.push(`Banned word found: "${w}"`);
  });

  return violations;
}
