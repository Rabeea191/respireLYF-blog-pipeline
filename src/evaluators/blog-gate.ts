/**
 * Stage 10 — Blog Evaluator Agent
 *
 * A dedicated evaluator (separate from the writer) that scores the draft
 * before it goes to HTML formatting.
 *
 * Hard fails block the pipeline and send targeted feedback to the writer.
 * Soft scores below 7/10 add improvement notes.
 * Max 3 writer iterations total.
 */

import { callClaudeJSON } from "../lib/claude";
import { logger } from "../lib/logger";
import type { BlogDraft, ContentBrief, SEOPackage, BlogEvaluation, AgentResult } from "../types";

const BANNED_WORDS = ["journey", "empower", "transform", "game-changer", "game changer", "revolutionary", "unlock"];

// ─── Programmatic hard-fail checks ────────────────────────────────────────
function runProgrammaticChecks(
  draft: BlogDraft,
  brief: ContentBrief,
  seo: SEOPackage
): Array<{ rule: string; details: string }> {
  const fails: Array<{ rule: string; details: string }> = [];
  const md = draft.markdown_content;
  const lower = md.toLowerCase();

  // 1. Word count
  if (draft.word_count < 800 || draft.word_count > 1200) {
    fails.push({
      rule: "word_count",
      details: `${draft.word_count} words — must be 800–1,200`,
    });
  }

  // 2. Primary keyword presence
  const pk = brief.yaml_frontmatter.primary_keyword.toLowerCase();
  const pkFirstWord = pk.split(" ")[0];
  const h1 = md.match(/^# (.+)/m)?.[1]?.toLowerCase() ?? "";
  if (!h1.includes(pkFirstWord)) {
    fails.push({ rule: "keyword_h1", details: `Primary keyword "${pk}" not found in H1` });
  }

  const paragraphs = md.replace(/^---[\s\S]+?---\n/, "").split("\n\n");
  const firstPara = paragraphs.find((p) => p.trim() && !p.startsWith("#") && !p.startsWith("<!--")) ?? "";
  if (!firstPara.toLowerCase().includes(pkFirstWord)) {
    fails.push({ rule: "keyword_first_para", details: `Primary keyword missing from opening paragraph` });
  }

  // 3. Banned words
  for (const word of BANNED_WORDS) {
    if (lower.includes(word.toLowerCase())) {
      fails.push({ rule: "banned_word", details: `Contains banned word: "${word}"` });
    }
  }

  // 4. FDA language violations
  const fdaViolations = [
    { bad: " causes ", hint: "use 'associated with'" },
    { bad: " triggers ", hint: "use 'tends to coincide with' or 'has been observed alongside'" },
    { bad: " prevents ", hint: "use 'may support'" },
    { bad: " cures ", hint: "remove or rephrase observationally" },
    { bad: "will improve", hint: "use 'may support' or 'research suggests'" },
    { bad: "will help your", hint: "use 'may help' or 'some people find'" },
  ];
  for (const v of fdaViolations) {
    if (lower.includes(v.bad.toLowerCase())) {
      fails.push({ rule: "fda_language", details: `Possible FDA violation: "${v.bad.trim()}" — ${v.hint}` });
    }
  }

  // 5. CTA heading
  if (!md.includes("Track What's Actually Affecting Your Breathing")) {
    fails.push({ rule: "cta_heading", details: `CTA heading must be exactly "Track What's Actually Affecting Your Breathing"` });
  }

  // 6. Image slots
  if (!md.includes("<!-- IMAGE: hero -->")) fails.push({ rule: "image_hero", details: "Missing <!-- IMAGE: hero --> slot" });
  if (!md.includes("<!-- IMAGE: inline -->")) fails.push({ rule: "image_inline", details: "Missing <!-- IMAGE: inline --> slot" });
  if (!md.includes("<!-- IMAGE: cta -->")) fails.push({ rule: "image_cta", details: "Missing <!-- IMAGE: cta --> slot" });

  // 7. Image PROMPT comments
  const promptCount = (md.match(/<!-- PROMPT:/g) ?? []).length;
  if (promptCount < 3) {
    fails.push({ rule: "image_prompts", details: `Only ${promptCount} image PROMPT blocks — need 3 (hero, inline, cta)` });
  }

  // 8. YMYL
  if (brief.ymyl_section_required && !lower.includes("when to see a doctor")) {
    fails.push({ rule: "ymyl", details: `"When to See a Doctor" section required but missing` });
  }

  // 9. Further Reading
  if (!lower.includes("further reading")) {
    fails.push({ rule: "further_reading", details: `"Further Reading" section missing` });
  }

  // 10. Prohibited sources
  const prohibited = ["healthline.com", "verywellhealth.com", "webmd.com", "medicalnewstoday.com"];
  for (const src of prohibited) {
    if (lower.includes(src)) {
      fails.push({ rule: "prohibited_source", details: `Prohibited source cited: ${src}` });
    }
  }

  return fails;
}

// ─── Claude soft-scoring ──────────────────────────────────────────────────
const EVAL_SYSTEM = `You are a senior content evaluator for RespireLYF. Your job is to score a blog draft on three qualitative dimensions.

Be strict but fair. A 7/10 is a solid article. 9-10 is exceptional.

Return ONLY valid JSON:
{
  "opening_hook": { "score": 1-10, "note": "..." },
  "product_intro_naturalness": { "score": 1-10, "note": "..." },
  "tone_quality": { "score": 1-10, "note": "..." },
  "overall_feedback": "2-3 sentences on the biggest strength and the most important improvement"
}`;

interface SoftScoreResult {
  opening_hook: { score: number; note: string };
  product_intro_naturalness: { score: number; note: string };
  tone_quality: { score: number; note: string };
  overall_feedback: string;
}

async function runSoftScoring(
  draft: BlogDraft,
  brief: ContentBrief
): Promise<SoftScoreResult> {
  const excerpt = draft.markdown_content.substring(0, 3000);

  return callClaudeJSON<SoftScoreResult>(
    EVAL_SYSTEM,
    `Evaluate this blog draft for RespireLYF.

Topic: "${brief.h1}"
Tone guidance: "${brief.tone_note}"
Opening angle brief asked for: "${brief.opening_angle}"

Article (first 3000 chars):
---
${excerpt}
---

Score:
1. opening_hook (1-10): Does it name the reader's exact frustration immediately? No definitions/stats as the opener?
2. product_intro_naturalness (1-10): Does the RespireLYF mention feel earned and natural, not like an ad?
3. tone_quality (1-10): Empathetic expert? Conversational? Avoids clinical distance and health clichés?`,
    "claude-sonnet-4-6"
  );
}

// ─── Main export ───────────────────────────────────────────────────────────
export async function runBlogEvaluator(
  draft: BlogDraft,
  brief: ContentBrief,
  seo: SEOPackage
): Promise<AgentResult<BlogEvaluation>> {
  const start = Date.now();

  return logger.timed("blog-gate", `Evaluating draft for "${brief.h1}"`, async () => {
    // Step 1: programmatic hard-fail checks
    const hardFails = runProgrammaticChecks(draft, brief, seo);

    // Step 2: soft scoring (even if hard fails exist — gives writer richer feedback)
    let softScores: SoftScoreResult;
    try {
      softScores = await runSoftScoring(draft, brief);
    } catch (err: any) {
      logger.warn("blog-gate", `Soft scoring failed: ${err.message}`);
      softScores = {
        opening_hook:            { score: 0, note: "Evaluation failed" },
        product_intro_naturalness: { score: 0, note: "Evaluation failed" },
        tone_quality:            { score: 0, note: "Evaluation failed" },
        overall_feedback:        "Soft scoring unavailable.",
      };
    }

    const softTotal = softScores.opening_hook.score +
      softScores.product_intro_naturalness.score +
      softScores.tone_quality.score;

    // Soft score notes as additional feedback
    const softIssues: string[] = [];
    if (softScores.opening_hook.score < 7)
      softIssues.push(`[OPENING HOOK ${softScores.opening_hook.score}/10] ${softScores.opening_hook.note}`);
    if (softScores.product_intro_naturalness.score < 7)
      softIssues.push(`[PRODUCT INTRO ${softScores.product_intro_naturalness.score}/10] ${softScores.product_intro_naturalness.note}`);
    if (softScores.tone_quality.score < 7)
      softIssues.push(`[TONE ${softScores.tone_quality.score}/10] ${softScores.tone_quality.note}`);

    const passed = hardFails.length === 0 && softTotal >= 21; // 7+7+7 minimum

    const feedbackParts: string[] = [];
    if (hardFails.length > 0) {
      feedbackParts.push("HARD FAILS (must fix):\n" + hardFails.map((f) => `• [${f.rule}] ${f.details}`).join("\n"));
    }
    if (softIssues.length > 0) {
      feedbackParts.push("SOFT SCORE IMPROVEMENTS:\n" + softIssues.join("\n"));
    }
    feedbackParts.push("OVERALL: " + softScores.overall_feedback);

    const evaluation: BlogEvaluation = {
      draft_id: draft.id,
      hard_fails: hardFails,
      soft_scores: {
        opening_hook:              softScores.opening_hook.score,
        product_intro_naturalness: softScores.product_intro_naturalness.score,
        tone_quality:              softScores.tone_quality.score,
        total:                     softTotal,
      },
      passed,
      feedback_for_writer: feedbackParts.join("\n\n"),
      evaluated_at: new Date().toISOString(),
    };

    if (passed) {
      logger.info("blog-gate", `✅ Draft approved — ${hardFails.length} hard fails, soft ${softTotal}/30`);
    } else {
      logger.warn("blog-gate", `❌ Draft failed — ${hardFails.length} hard fails, soft ${softTotal}/30`);
    }

    return {
      success: true,
      data: evaluation,
      iteration: draft.iteration_count,
      duration_ms: Date.now() - start,
    };
  });
}
