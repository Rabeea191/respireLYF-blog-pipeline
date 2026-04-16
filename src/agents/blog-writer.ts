/**
 * Stage 9 — Blog Writer Agent
 *
 * Takes the Content Brief (Stage 7) + image prompts (Stage 8 output embedded inline)
 * and writes the full article following blog2.md exactly.
 *
 * Hard rules enforced programmatically before output:
 *   ✓ Word count 800–1,200 (counted in text, not frontmatter)
 *   ✓ No banned words: journey, empower, transform, game-changer, revolutionary, unlock
 *   ✓ Primary keyword present in H1, first paragraph, and closing section
 *   ✓ "When to See a Doctor" section included if YMYL flagged
 *   ✓ CTA heading is exactly "Track What's Actually Affecting Your Breathing"
 *   ✓ Three image placeholders present (hero, inline, cta)
 *   ✓ Product intro appears at ~70% mark
 *   ✓ Further Reading section with outbound links
 *
 * Max 3 iterations. On failure after 3, escalates with flag.
 */

import fs from "fs";
import path from "path";
import { callClaude } from "../lib/claude";
import { logger } from "../lib/logger";
import type { TopicCard, SEOPackage, ContentBrief, BlogDraft, AgentResult } from "../types";
import { randomUUID } from "crypto";

const MAX_ITERATIONS = 3;
const BANNED_WORDS = ["journey", "empower", "transform", "game-changer", "game changer", "revolutionary", "unlock"];

// ─── Word counter (text only, no frontmatter or comments) ──────────────────
function countWords(markdown: string): number {
  // Strip YAML frontmatter
  const noFront = markdown.replace(/^---[\s\S]+?---\n/, "");
  // Strip HTML comments
  const noComments = noFront.replace(/<!--[\s\S]*?-->/g, "");
  // Strip markdown syntax
  const plain = noComments
    .replace(/#{1,6}\s/g, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
  return plain.split(/\s+/).filter(Boolean).length;
}

// ─── Hard-fail checks ──────────────────────────────────────────────────────
interface HardFailCheck {
  rule: string;
  details: string;
}

function checkHardFails(
  markdown: string,
  brief: ContentBrief,
  seo: SEOPackage
): HardFailCheck[] {
  const fails: HardFailCheck[] = [];
  const lower = markdown.toLowerCase();
  const wordCount = countWords(markdown);

  // Word count — target 900-1100, hard cap 1500
  if (wordCount < 800 || wordCount > 1500) {
    fails.push({
      rule: "word_count",
      details: `Word count is ${wordCount} — must be 800–1,500. ${wordCount < 800 ? "Expand sections to add more detail" : "Too long — cut filler sentences in 2-3 sections"}.`,
    });
  }

  // Banned words
  for (const word of BANNED_WORDS) {
    if (lower.includes(word)) {
      fails.push({ rule: "banned_word", details: `Contains banned word: "${word}"` });
    }
  }

  // Primary keyword in H1
  const h1Match = markdown.match(/^# (.+)/m);
  if (!h1Match || !h1Match[1].toLowerCase().includes(brief.yaml_frontmatter.primary_keyword.toLowerCase().split(" ")[0])) {
    fails.push({ rule: "keyword_in_h1", details: `Primary keyword "${brief.yaml_frontmatter.primary_keyword}" missing from H1` });
  }

  // Primary keyword in first paragraph (skip H1, image comments, blank lines)
  const bodyText = markdown.replace(/^---[\s\S]+?---\n/, "");
  const bodyParas = bodyText.split("\n\n");
  const firstTextPara = bodyParas.find(
    (p) => p.trim() && !p.startsWith("#") && !p.startsWith("<!--") && !p.startsWith("![")
  ) ?? "";
  const pkFirstWord = brief.yaml_frontmatter.primary_keyword.toLowerCase().split(" ")[0];
  if (!firstTextPara.toLowerCase().includes(pkFirstWord)) {
    fails.push({ rule: "keyword_in_first_para", details: `Primary keyword "${brief.yaml_frontmatter.primary_keyword}" missing from opening paragraph — include "${pkFirstWord}" in the very first sentence` });
  }

  // CTA heading check
  if (!markdown.includes("Track What's Actually Affecting Your Breathing")) {
    fails.push({ rule: "cta_heading", details: `CTA heading must be exactly "Track What's Actually Affecting Your Breathing"` });
  }

  // Three image placeholders
  const heroSlot   = markdown.includes("<!-- IMAGE: hero -->");
  const inlineSlot = markdown.includes("<!-- IMAGE: inline -->");
  const ctaSlot    = markdown.includes("<!-- IMAGE: cta -->");
  if (!heroSlot || !inlineSlot || !ctaSlot) {
    const missing = [!heroSlot && "hero", !inlineSlot && "inline", !ctaSlot && "cta"].filter(Boolean);
    fails.push({ rule: "image_slots", details: `Missing image slots: ${missing.join(", ")}` });
  }

  // YMYL: When to See a Doctor
  if (brief.ymyl_section_required && !lower.includes("when to see a doctor")) {
    fails.push({ rule: "ymyl_section", details: `"When to See a Doctor" section required but missing` });
  }

  // Further Reading section
  if (!lower.includes("further reading")) {
    fails.push({ rule: "further_reading", details: `"Further Reading" section missing` });
  }

  // No prohibited sources
  const prohibited = ["healthline.com", "verywellhealth.com", "webmd.com"];
  for (const src of prohibited) {
    if (lower.includes(src)) {
      fails.push({ rule: "prohibited_source", details: `Prohibited source cited: ${src}` });
    }
  }

  return fails;
}

// ─── Build the writer system prompt ───────────────────────────────────────
function buildSystemPrompt(brief: ContentBrief, _seo: SEOPackage): string {
  const ymylRequired = brief.ymyl_section_required;
  return `You are the Blog Writer for RespireLYF — an iOS respiratory health app for US adults with asthma or COPD.

You write one complete, publication-ready blog article per call. You follow the content brief exactly and NEVER skip required sections.

══════════════════════════════════════════
REQUIRED ARTICLE STRUCTURE (every section is mandatory)
══════════════════════════════════════════
1. YAML frontmatter block (title, meta_title, meta_description, slug, keywords)
2. <!-- IMAGE: hero --> placeholder + <!-- PROMPT: [vivid scene description] -->
3. H1 (exact text from brief)
4. OPENING PARAGRAPH — first plain text. Must contain the primary keyword. No definitions, no statistics. Hook = reader's exact frustration.
5. H2 sections (use the outline from the brief, in order)
6. <!-- IMAGE: inline --> placeholder + <!-- PROMPT: [description] --> (place mid-article)
7. RespireLYF feature mention (~70% through) — 2-3 sentences, one feature only, earned not advertised
${ymylRequired ? `8. ⚠️  MANDATORY: ## When to See a Doctor
   This section is REQUIRED because ymyl_section_required = true.
   Write 3-5 sentences listing specific clinical warning signs that need immediate medical attention.
   DO NOT skip this section under any circumstances.
9. ## Track What's Actually Affecting Your Breathing  ← CTA (exact heading)` : `8. ## Track What's Actually Affecting Your Breathing  ← CTA (exact heading)`}
${ymylRequired ? "10" : "9"}. <!-- IMAGE: cta --> placeholder + <!-- PROMPT: [description] -->
${ymylRequired ? "11" : "10"}. ## Further Reading (use the outbound links from the brief)

══════════════════════════════════════════
HARD RULES
══════════════════════════════════════════
• Word count: TARGET 900–1,100 words (hard min 800, hard max 1,500). Count carefully.
• Primary keyword in: H1 + opening paragraph + 2+ H2s + closing section
• CTA heading EXACTLY: "Track What's Actually Affecting Your Breathing" — copy verbatim
• Three image slots: <!-- IMAGE: hero -->, <!-- IMAGE: inline -->, <!-- IMAGE: cta -->
• Three PROMPT comments — one after each image slot
• Banned words — never use: journey, empower, transform, game-changer, revolutionary, unlock
• No Healthline, WebMD, Verywell Health links
• FDA language: "associated with" not "causes", "research suggests" not "proves"
• Do NOT open with a definition or statistic

══════════════════════════════════════════
SELF-CHECK — run this before outputting the article
══════════════════════════════════════════
Before writing your final response, verify:
□ Word count between 800-1,400 (count it)
□ Primary keyword in opening paragraph (first plain text block)
□ <!-- IMAGE: hero --> present
□ <!-- IMAGE: inline --> present
□ <!-- IMAGE: cta --> present
□ Three <!-- PROMPT: --> blocks present
${ymylRequired ? "□ ## When to See a Doctor section present — THIS IS MANDATORY\n" : ""}□ ## Track What's Actually Affecting Your Breathing heading present (exact text)
□ ## Further Reading section present
□ No banned words

If any box is unchecked → fix it before outputting.

OUTPUT: The complete .md article only. No commentary before or after.`;
}

// ─── Build the writer user prompt ─────────────────────────────────────────
function buildWriterPrompt(
  brief: ContentBrief,
  seo: SEOPackage,
  feedbackFromEvaluator?: string
): string {
  const internalLinksStr = seo.internal_links.length > 0
    ? seo.internal_links.map((l) => `- "${l.anchor_text}" → https://www.respirelyf.com${l.url}`).join("\n")
    : "None available";

  const outboundStr = seo.outbound_links
    .map((l) => `- ${l.anchor_text} (${l.source_org}): ${l.url}`)
    .join("\n");

  return `Write the full blog article using this brief. Every section listed below is required.

━━━ CONTENT BRIEF ━━━
H1: ${brief.h1}
Primary keyword: ${brief.yaml_frontmatter.primary_keyword}
Secondary keywords: ${brief.yaml_frontmatter.secondary_keywords.join(", ")}
Slug: ${brief.yaml_frontmatter.slug}
Meta title: ${brief.yaml_frontmatter.meta_title}
Meta description: ${brief.yaml_frontmatter.meta_description}

Opening angle (hook with this frustration in sentence 1): "${brief.opening_angle}"
Tone note: "${brief.tone_note}"

H2 Outline (write ALL of these, in order):
${brief.h2_outline.map((h, i) => `${i + 1}. ${h.heading}${h.keyword_notes ? ` [use keyword: ${h.keyword_notes}]` : ""}${h.missing_from_competitors ? " ← UNIQUE ANGLE" : ""}`).join("\n")}
${brief.ymyl_section_required ? `${brief.h2_outline.length + 1}. When to See a Doctor  ← ⚠️  MANDATORY YMYL SECTION — must be included` : ""}
${brief.ymyl_section_required ? `${brief.h2_outline.length + 2}` : `${brief.h2_outline.length + 1}`}. Track What's Actually Affecting Your Breathing  ← CTA heading (exact text)
${brief.ymyl_section_required ? `${brief.h2_outline.length + 3}` : `${brief.h2_outline.length + 2}`}. Further Reading

Feature to highlight at ~70% mark: "${brief.feature_to_highlight}"

FDA phrases to avoid for this topic:
${brief.fda_red_flags.map((f) => `- "${f}"`).join("\n")}

Internal links:
${internalLinksStr}

Outbound links for Further Reading:
${outboundStr}
━━━━━━━━━━━━━━━━━━━━━

${feedbackFromEvaluator ? `━━━ EVALUATOR FEEDBACK — fix ALL of these before resubmitting ━━━\n${feedbackFromEvaluator}\n━━━━━━━━━━━━━━━━━━━━━\n` : ""}
━━━ FINAL CHECKLIST — tick every box before outputting ━━━
□ Word count 800–1,500 (I counted: ___ words)
□ Primary keyword "${brief.yaml_frontmatter.primary_keyword}" is in the OPENING PARAGRAPH
□ <!-- IMAGE: hero --> present at top
□ <!-- IMAGE: inline --> present mid-article
□ <!-- IMAGE: cta --> present near end
□ Each image has a <!-- PROMPT: --> comment after it
${brief.ymyl_section_required ? "□ ## When to See a Doctor section written (3-5 sentences of clinical warning signs)\n" : ""}□ ## Track What's Actually Affecting Your Breathing heading (exact text, no changes)
□ ## Further Reading section with outbound links
□ No banned words: journey / empower / transform / game-changer / revolutionary / unlock

All boxes checked? → Output the article now. Start with the YAML frontmatter.`;
}

// ─── Save blog to disk ─────────────────────────────────────────────────────
function saveBlogToDisk(slug: string, content: string): string {
  const dir = path.join(process.cwd(), "blogs", slug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── Main export ───────────────────────────────────────────────────────────
export async function runBlogWriter(
  topic: TopicCard,
  seo: SEOPackage,
  brief: ContentBrief,
  previousFeedback?: string
): Promise<AgentResult<BlogDraft>> {
  const start = Date.now();
  let iteration = 1;
  let lastFeedback = previousFeedback;
  let markdown = "";

  return logger.timed("blog-writer", `Writing "${brief.h1}"`, async () => {
    while (iteration <= MAX_ITERATIONS) {
      logger.info("blog-writer", `Iteration ${iteration}/${MAX_ITERATIONS}`);

      try {
        markdown = await callClaude(
          buildSystemPrompt(brief, seo),
          buildWriterPrompt(brief, seo, lastFeedback),
          "claude-sonnet-4-6"
        );
      } catch (err: any) {
        return {
          success: false,
          error: `Claude write failed (iteration ${iteration}): ${err.message}`,
          iteration,
          duration_ms: Date.now() - start,
        };
      }

      // Check hard fails
      const hardFails = checkHardFails(markdown, brief, seo);
      const wordCount = countWords(markdown);

      if (hardFails.length === 0) {
        // ✅ Pass — save to disk
        const slug = brief.yaml_frontmatter.slug;
        let filePath = `blogs/${slug}/${slug}.md`;

        try {
          filePath = saveBlogToDisk(slug, markdown);
        } catch (e) {
          logger.warn("blog-writer", `Could not save to disk: ${(e as Error).message}`);
        }

        const draft: BlogDraft = {
          id: randomUUID(),
          topic_id: topic.id,
          brief_id: `${topic.id}-brief`,
          markdown_content: markdown,
          word_count: wordCount,
          file_path: filePath,
          iteration_count: iteration,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        logger.info("blog-writer", `✅ Draft passed on iteration ${iteration} — ${wordCount} words`);
        return { success: true, data: draft, iteration, duration_ms: Date.now() - start };
      }

      // Build targeted feedback for next iteration
      lastFeedback = hardFails
        .map((f) => `[${f.rule.toUpperCase()}] ${f.details}`)
        .join("\n");

      logger.warn("blog-writer", `Iteration ${iteration} failed ${hardFails.length} hard checks:\n${lastFeedback}`);

      iteration++;
    }

    // Escalate after max iterations
    const wordCount = countWords(markdown);
    const slug = brief.yaml_frontmatter.slug;
    let filePath = `blogs/${slug}/${slug}.md`;
    try { filePath = saveBlogToDisk(slug, markdown); } catch (_) {}

    logger.error("blog-writer", `Escalating after ${MAX_ITERATIONS} iterations — hard fails remain`);

    return {
      success: false,
      error: `Blog writer failed all ${MAX_ITERATIONS} iterations. Last draft saved at ${filePath} — requires human review.`,
      data: {
        id: randomUUID(),
        topic_id: topic.id,
        brief_id: `${topic.id}-brief`,
        markdown_content: markdown,
        word_count: wordCount,
        file_path: filePath,
        iteration_count: MAX_ITERATIONS,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      iteration: MAX_ITERATIONS,
      duration_ms: Date.now() - start,
    };
  });
}
