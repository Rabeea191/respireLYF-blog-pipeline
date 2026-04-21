/**
 * Stage 7 — Content Brief Agent
 *
 * Takes the SEO package + approved topic and assembles a complete
 * content brief that the Blog Writer Agent will execute against.
 *
 * Output includes:
 *   - YAML frontmatter (meta title, meta description, slug, keywords)
 *   - H1 + H2 outline with keyword placement notes
 *   - Feature to highlight
 *   - Opening paragraph angle
 *   - YMYL section flag
 *   - Tone note specific to this article
 *   - FDA language red flags for this topic
 */

import { callClaudeJSON } from "../lib/claude";
import { logger } from "../lib/logger";
import type { TopicCard, SEOPackage, ContentBrief, AgentResult } from "../types";

const SYSTEM_PROMPT = `You are a content strategist for RespireLYF — an iOS respiratory health app for US adults with asthma or COPD.

You produce detailed content briefs that blog writers execute against. Your brief must be specific enough that a writer produces a consistent, high-quality article on the first attempt.

BRAND RULES baked into every brief:
- Target word count: 800 to 1,200 words (firm).
- Tone: empathetic expert, not pharma brand. Like a knowledgeable friend who lives with asthma or COPD.
- FDA language: observational only ("associated with", "tends to coincide with", "research suggests"). Never use "causes", "triggers", "proves", or "prevents".
- Product intro appears at 70% mark, one feature only, 2 to 3 sentences.
- CTA heading is always exactly: "Track What's Actually Affecting Your Breathing".
- Banned words: journey, empower, transform, game-changer, revolutionary, unlock.
- NEVER open with a definition or statistic. Hook with the reader's frustration first.

══════════════════════════════════════════
H1 TITLE PSYCHOLOGY (apply to every H1 you write)
══════════════════════════════════════════
The H1 must EARN the click and keep the primary keyword intact for SEO. Use one of these patterns:

• Curiosity gap: "The 7 Foods That Could Be Triggering Your Asthma"
• Counter-intuitive claim: "Why Warm Rooms Can Make Asthma Worse Than Cold Air"
• Specific number + promise: "5 Peak Flow Readings That Mean You Should Call Your Doctor"
• Targeted frustration: "Why Asthma Wakes You at 4 AM (And How to Stop It)"
• Direct question the reader asks: "Is This Cardiac Cough? 6 Signs To Watch For"

H1 RULES:
- Keep primary keyword in the first 45 characters for SEO.
- Build curiosity in the last 15 characters. Parentheticals like "(And How to Fix It)" or "(Without Meds)" work well.
- NEVER use em-dashes (—) or en-dashes (–) in the H1 or meta_title. Use a colon, comma, or parenthesis instead.
- Be specific. "Quick tips" is dead; "3 inhaler mistakes 70% of patients make" is alive.
- Never promise what the article can't deliver. No clickbait.

Return ONLY valid JSON matching the ContentBrief shape.`;

interface ContentBriefRaw {
  yaml_frontmatter: {
    meta_title: string;
    meta_description: string;
    primary_keyword: string;
    secondary_keywords: string[];
    slug: string;
  };
  h1: string;
  h2_outline: Array<{
    heading: string;
    keyword_notes?: string;
    missing_from_competitors?: boolean;
  }>;
  opening_angle: string;
  tone_note: string;
  fda_red_flags: string[];
}

async function buildBrief(
  topic: TopicCard,
  seo: SEOPackage
): Promise<ContentBriefRaw> {
  const prompt = `Build a complete content brief for this article.

APPROVED TOPIC:
Title: "${topic.title}"
Primary keyword: "${topic.primary_keyword}"
Rationale: ${topic.rationale}
RespireLYF feature to highlight: ${topic.respireLYF_feature}
YMYL (When to See a Doctor required): ${seo.ymyl_confirmed}

SEO PACKAGE:
Secondary keywords: ${seo.secondary_keywords.join(", ")}
Suggested H2 outline from research: ${seo.suggested_h2_outline.join(" | ")}
Keyword difficulty: ${seo.keyword_difficulty_estimate}
Competitor gap notes:
${seo.competitor_urls.map((c) => `- ${c.url}: ${c.gap_note}`).join("\n")}

INTERNAL LINKS TO WEAVE IN:
${seo.internal_links.map((l) => `- "${l.anchor_text}" → ${l.url}`).join("\n") || "None"}

OUTBOUND LINKS FOR FURTHER READING:
${seo.outbound_links.map((l) => `- ${l.anchor_text} (${l.source_org}) → ${l.url}`).join("\n")}

Produce the brief:
1. yaml_frontmatter: meta_title (55-60 chars), meta_description (140-155 chars), slug (url-safe), primary and secondary keywords
2. h1: exact article title (mirrors primary keyword, under 60 chars)
3. h2_outline: 4-5 headings — use the SEO research + fill in what competitors miss (mark missing_from_competitors: true)
4. opening_angle: the exact reader frustration to name in sentence 1 (specific, not generic)
5. tone_note: article-specific guidance (e.g. "calming, not alarmist" or "validating, clinical references kept accessible")
6. fda_red_flags: 3-5 specific phrases to avoid for THIS topic`;

  return callClaudeJSON<ContentBriefRaw>(SYSTEM_PROMPT, prompt, "claude-sonnet-4-6");
}

// ─── Validate brief ────────────────────────────────────────────────────────
function validateBrief(raw: ContentBriefRaw): string[] {
  const errors: string[] = [];
  const fm = raw.yaml_frontmatter;

  if (!fm?.meta_title) errors.push("Missing meta_title");
  else if (fm.meta_title.length > 65) errors.push(`meta_title too long: ${fm.meta_title.length} chars`);

  if (!fm?.meta_description) errors.push("Missing meta_description");
  else if (fm.meta_description.length < 130 || fm.meta_description.length > 160)
    errors.push(`meta_description length ${fm.meta_description.length} — aim for 140-155`);

  if (!fm?.slug) errors.push("Missing slug");
  if (!raw.h1) errors.push("Missing H1");
  if ((raw.h2_outline ?? []).length < 3) errors.push("Less than 3 H2s in outline");
  if (!raw.opening_angle) errors.push("Missing opening_angle");
  if (!raw.tone_note) errors.push("Missing tone_note");

  return errors;
}

// ─── Main export ───────────────────────────────────────────────────────────
export async function runContentBrief(
  topic: TopicCard,
  seo: SEOPackage
): Promise<AgentResult<ContentBrief>> {
  const start = Date.now();

  return logger.timed("content-brief", `Building brief for "${topic.title}"`, async () => {
    let raw: ContentBriefRaw;

    try {
      raw = await buildBrief(topic, seo);
    } catch (err: any) {
      return {
        success: false,
        error: `Claude brief generation failed: ${err.message}`,
        iteration: 1,
        duration_ms: Date.now() - start,
      };
    }

    const errors = validateBrief(raw);
    if (errors.length > 0) {
      logger.warn("content-brief", `Validation notes: ${errors.join("; ")}`);
    }

    const brief: ContentBrief = {
      topic_id: topic.id,
      seo_package_id: seo.topic_id,
      yaml_frontmatter: {
        meta_title:          raw.yaml_frontmatter?.meta_title ?? topic.title,
        meta_description:    raw.yaml_frontmatter?.meta_description ?? "",
        primary_keyword:     raw.yaml_frontmatter?.primary_keyword ?? topic.primary_keyword,
        secondary_keywords:  raw.yaml_frontmatter?.secondary_keywords ?? seo.secondary_keywords,
        slug:                raw.yaml_frontmatter?.slug ?? topic.primary_keyword.toLowerCase().replace(/\s+/g, "-"),
      },
      h1:                      raw.h1 ?? topic.title,
      h2_outline:              raw.h2_outline ?? [],
      word_count_target:       { min: 800, max: 1200 },
      feature_to_highlight:    topic.respireLYF_feature,
      opening_angle:           raw.opening_angle ?? "",
      ymyl_section_required:   seo.ymyl_confirmed,
      tone_note:               raw.tone_note ?? "",
      fda_red_flags:           raw.fda_red_flags ?? [],
      created_at:              new Date().toISOString(),
    };

    logger.info("content-brief", `Brief ready — ${brief.h2_outline.length} H2s, YMYL: ${brief.ymyl_section_required}`);

    return {
      success: true,
      data: brief,
      iteration: 1,
      duration_ms: Date.now() - start,
    };
  });
}
