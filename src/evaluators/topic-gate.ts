/**
 * Tier 1 — Topic Gate (Mini Evaluator)
 *
 * Two-phase evaluation:
 *   Phase 1 — Hard format checks (fast, local, no LLM needed)
 *   Phase 2 — Rubric scoring via Claude (5 dimensions × 10 pts = 50 max)
 *
 * Gate flags:
 *   "clean"  = score ≥ 40/50  → goes straight to human as approved candidate
 *   "caution"= score 30–39    → goes to human with a yellow flag + editorial note
 *   "revise" = score < 30     → sent back to Topic Generator with specific feedback
 */

import { callClaudeJSON } from "../lib/claude";
import { logger } from "../lib/logger";
import { validateTopicCard } from "../agents/topic-generator";
import type { TopicCard, TopicEvaluation } from "../types";

const SYSTEM_PROMPT = `You are the Topic Evaluator for RespireLYF — a respiratory health app for US adults with asthma or COPD.

You evaluate blog topic candidates on 5 dimensions (1–10 each, 50 max).

SCORING RUBRIC:

1. seo_potential (1–10)
   Estimate how rankable this keyword is for a growing health app (domain authority ~30).
   10 = low-competition, high-volume, long-tail patient query we can realistically rank for
   5  = medium competition, decent volume
   1  = dominated by WebMD/Mayo/CDC — we cannot rank for this

2. brand_fit (1–10)
   Does this article naturally showcase a specific RespireLYF feature?
   10 = the feature connection is direct and non-forced (e.g. cold weather → Weather HD)
   5  = moderate connection requires some explanation
   1  = no natural product connection possible

3. reader_urgency (1–10)
   Would a patient with asthma or COPD search this RIGHT NOW this week?
   10 = urgent, active search behaviour this week (seasonal spike, recent news)
   5  = evergreen — always relevant but no urgency spike
   1  = niche or low-frequency concern

4. content_differentiation (1–10)
   Can RespireLYF say something meaningfully different from the top 3 Google results?
   10 = clear gap — top results are generic, we can own the specific angle
   5  = moderate gap — we can add some unique perspective
   1  = fully saturated — Healthline/WebMD/Mayo already cover this exhaustively

5. fda_safe_angle (1–10)
   Can this topic be written compliantly — observational, never diagnostic/prescriptive?
   10 = straightforward observational — "patterns suggest...", "research shows..."
   5  = needs careful handling but doable
   1  = impossible to write compliantly (e.g. "how to diagnose your asthma at home")

Also write a 2-sentence editorial_note for the human reviewer:
  Sentence 1: Why this topic is worth considering
  Sentence 2: The one risk or caveat the reviewer should know

Return a JSON array — one evaluation object per topic, same order as input.`;

interface RawEvaluation {
  seo_potential: number;
  brand_fit: number;
  reader_urgency: number;
  content_differentiation: number;
  fda_safe_angle: number;
  editorial_note: string;
}

export async function runTopicGate(
  cards: TopicCard[],
  publishedSlugs: string[],
  run_id: string
): Promise<TopicCard[]> {
  logger.info("topic_gate", `Evaluating ${cards.length} topic cards`, { run_id });

  // Phase 1 — Hard format checks (local, no LLM)
  const formatIssues: Record<string, string[]> = {};
  for (const card of cards) {
    const violations = validateTopicCard(card, publishedSlugs);
    if (violations.length > 0) {
      formatIssues[card.id] = violations;
      logger.warn("topic_gate", `Format violations on topic "${card.title}"`, {
        run_id,
        data: { violations },
      });
    }
  }

  // Phase 2 — Rubric scoring (LLM)
  const input = cards.map((c, idx) => ({
    idx,
    title: c.title,
    primary_keyword: c.primary_keyword,
    rationale: c.rationale,
    feature: c.respireLYF_feature,
    topic_type: c.topic_type,
    ymyl: c.ymyl_flag,
    format_issues: formatIssues[c.id] ?? [],
  }));

  const raw = await callClaudeJSON<RawEvaluation[]>({
    stage: "topic_gate",
    run_id,
    system: SYSTEM_PROMPT,
    user: `Evaluate these ${cards.length} topic candidates:\n\n${JSON.stringify(input, null, 2)}`,
    temperature: 0.1,
    schema_hint: `Array of { seo_potential, brand_fit, reader_urgency, content_differentiation, fda_safe_angle, editorial_note }`,
  });

  const scoresArray = Array.isArray(raw) ? raw : [];

  // Merge evaluations back onto cards
  const evaluated: TopicCard[] = cards.map((card, idx) => {
    const scores = scoresArray[idx];
    const hasFormatIssues = (formatIssues[card.id]?.length ?? 0) > 0;

    if (!scores) {
      // Fallback — if Claude failed to score this card
      const evaluation: TopicEvaluation = {
        topic_id: card.id,
        scores: {
          seo_potential: 0,
          brand_fit: 0,
          reader_urgency: 0,
          content_differentiation: 0,
          fda_safe_angle: 0,
          total: 0,
        },
        editorial_note: "Evaluation failed — manual review required.",
        gate_flag: "revise",
        evaluated_at: new Date().toISOString(),
      };
      return { ...card, evaluation };
    }

    const total =
      scores.seo_potential +
      scores.brand_fit +
      scores.reader_urgency +
      scores.content_differentiation +
      scores.fda_safe_angle;

    let gate_flag: TopicEvaluation["gate_flag"];
    if (hasFormatIssues || total < 30) {
      gate_flag = "revise";
    } else if (total < 40) {
      gate_flag = "caution";
    } else {
      gate_flag = "clean";
    }

    const evaluation: TopicEvaluation = {
      topic_id: card.id,
      scores: {
        seo_potential:           scores.seo_potential,
        brand_fit:               scores.brand_fit,
        reader_urgency:          scores.reader_urgency,
        content_differentiation: scores.content_differentiation,
        fda_safe_angle:          scores.fda_safe_angle,
        total,
      },
      editorial_note: hasFormatIssues
        ? `FORMAT ISSUES: ${formatIssues[card.id].join("; ")}. ${scores.editorial_note}`
        : scores.editorial_note,
      gate_flag,
      evaluated_at: new Date().toISOString(),
    };

    logger.info("topic_gate", `"${card.title}" → ${total}/50 [${gate_flag}]`, { run_id });

    return { ...card, evaluation };
  });

  const summary = {
    clean:  evaluated.filter((c) => c.evaluation?.gate_flag === "clean").length,
    caution:evaluated.filter((c) => c.evaluation?.gate_flag === "caution").length,
    revise: evaluated.filter((c) => c.evaluation?.gate_flag === "revise").length,
  };

  logger.info("topic_gate", `Summary: ${summary.clean} clean, ${summary.caution} caution, ${summary.revise} revise`, { run_id });

  return evaluated;
}

/**
 * Builds feedback string for Topic Generator regeneration.
 * Only called for cards with gate_flag = "revise".
 */
export function buildRegenerationFeedback(cards: TopicCard[]): string {
  const reviseCards = cards.filter((c) => c.evaluation?.gate_flag === "revise");
  if (reviseCards.length === 0) return "";

  const lines = reviseCards.map((c) => {
    const scores = c.evaluation?.scores;
    const weak = Object.entries(scores ?? {})
      .filter(([k, v]) => k !== "total" && (v as number) < 5)
      .map(([k]) => k.replace(/_/g, " "))
      .join(", ");
    return `- "${c.title}": ${c.evaluation?.editorial_note ?? ""} Weak areas: ${weak || "format issues"}.`;
  });

  return `The following topics need to be regenerated:\n${lines.join("\n")}\n\nFor replacements: focus on lower-competition, more specific patient queries with stronger brand fit.`;
}
