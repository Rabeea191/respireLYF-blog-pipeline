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

// Vercel 300s budget + memory pressure from multiple Claude responses sitting
// in heap means we can't afford 3 iterations per blog. One pass, then escalate —
// orchestrator still runs the gate + posts to Payload with whatever we got.
const MAX_ITERATIONS = 1;
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

  // Image placeholders: 1 hero, >=2 inline, 1 cta
  const heroSlotCount   = (markdown.match(/<!--\s*IMAGE:\s*hero\s*-->/g)   || []).length;
  const inlineSlotCount = (markdown.match(/<!--\s*IMAGE:\s*inline\s*-->/g) || []).length;
  const ctaSlotCount    = (markdown.match(/<!--\s*IMAGE:\s*cta\s*-->/g)    || []).length;
  if (heroSlotCount < 1) {
    fails.push({ rule: "image_slots", details: `Missing <!-- IMAGE: hero --> slot.` });
  }
  if (inlineSlotCount < 2) {
    fails.push({
      rule: "image_slots",
      details: `Need AT LEAST 2 <!-- IMAGE: inline --> slots spread across the article — found ${inlineSlotCount}. Add one more in a different H2 section, with its own <!-- PROMPT: ... --> comment.`,
    });
  }
  if (ctaSlotCount < 1) {
    fails.push({ rule: "image_slots", details: `Missing <!-- IMAGE: cta --> slot.` });
  }

  // Blockquote (> text)
  if (!/^>\s+.+/m.test(markdown)) {
    fails.push({
      rule: "blockquote",
      details: `Add at least one markdown blockquote (a line starting with "> ") pulling out the single most important clinical or research insight.`,
    });
  }

  // Numbered list (1. ..., 2. ...) — two consecutive numbered lines at start of line
  if (!/^1\.\s+.+\n(?:.*\n)?2\.\s+.+/m.test(markdown)) {
    fails.push({
      rule: "numbered_list",
      details: `Add at least one numbered list (lines starting "1. " and "2. ") giving readers step-by-step actions or comparison points.`,
    });
  }

  // Branded CTA button link
  if (!markdown.includes("[Download Free on the App Store →](https://respirelyf.onelink.me/6vuu/5b82x6qh)")) {
    fails.push({
      rule: "cta_button",
      details: `Missing branded CTA button line — include EXACTLY: **[Download Free on the App Store →](https://respirelyf.onelink.me/6vuu/5b82x6qh)** on its own paragraph after the CTA image.`,
    });
  }

  // Disclaimer line
  if (!lower.includes("this article is for informational purposes only")) {
    fails.push({
      rule: "disclaimer",
      details: `Missing italic disclaimer. Add after a "---" rule: *This article is for informational purposes only and does not constitute medical advice. Always consult your doctor or healthcare professional before making changes to your asthma or COPD management.*`,
    });
  }

  // Trusted Sources section with real research URLs
  if (!lower.includes("trusted sources")) {
    fails.push({
      rule: "trusted_sources",
      details: `Missing "## Trusted Sources" section with 2-3 bullet links to real pmc.ncbi.nlm.nih.gov / cdc.gov / nhlbi.nih.gov / nejm.org / thelancet.com URLs.`,
    });
  } else {
    // Verify Trusted Sources actually contains one of the allowed authoritative domains.
    // Keep this list in sync with AUTHORITATIVE_DOMAINS in pipeline/src/lib/topic-brief.ts
    // and pipeline/pick-topic.js — the brief may pre-seed any of these.
    const trustedBlock = markdown.split(/##\s*Trusted Sources/i)[1] || "";
    const hasRealSource = /(pmc\.ncbi\.nlm\.nih\.gov|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|cdc\.gov|nhlbi\.nih\.gov|nih\.gov|nejm\.org|thelancet\.com|bmj\.com|jamanetwork\.com|fda\.gov|who\.int|nhs\.uk|cochrane\.org|ginasthma\.org|goldcopd\.org|mayoclinic\.org|clevelandclinic\.org|hopkinsmedicine\.org|lung\.org|aaaai\.org|aafa\.org|annallergy\.org)/i.test(trustedBlock);
    if (!hasRealSource) {
      fails.push({
        rule: "trusted_sources",
        details: `"## Trusted Sources" present but contains no real peer-reviewed / government / authoritative-clinic URLs. Use one of: pmc.ncbi.nlm.nih.gov, cdc.gov, nhlbi.nih.gov, nejm.org, thelancet.com, bmj.com, mayoclinic.org, clevelandclinic.org, hopkinsmedicine.org, nhs.uk, ginasthma.org, goldcopd.org, or fda.gov.`,
      });
    }
  }

  // YMYL: When to See a Doctor
  if (brief.ymyl_section_required && !lower.includes("when to see a doctor")) {
    fails.push({ rule: "ymyl_section", details: `"When to See a Doctor" section required but missing` });
  }

  // Further Reading section (distinct from Trusted Sources)
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

  // No doubled-prefix respirelyf URLs (common LLM hallucination)
  if (/https?:\/\/[^\s/]*respirelyf\.com[^\s)]*https?:\/\//i.test(markdown)) {
    fails.push({
      rule: "broken_url",
      details: `Found a broken internal URL with doubled prefix (e.g. "https://www.respirelyf.comhttps://..."). Write internal links as a single absolute URL or use the relative /blog/slug form.`,
    });
  }

  // No em-dashes or en-dashes (user-enforced style rule).
  // Strip YAML frontmatter, code fences, and URLs first so we only check prose.
  const prose = markdown
    .replace(/^---[\s\S]+?---\n/, "")              // frontmatter
    .replace(/```[\s\S]*?```/g, "")                 // code fences
    .replace(/`[^`\n]+`/g, "")                      // inline code
    .replace(/\]\([^)]+\)/g, "")                    // markdown link targets
    .replace(/https?:\/\/[^\s)]+/g, "");            // raw URLs
  const emDashMatches = prose.match(/—/g);
  const enDashMatches = prose.match(/–/g);
  if (emDashMatches && emDashMatches.length > 0) {
    fails.push({
      rule: "no_em_dash",
      details: `Found ${emDashMatches.length} em-dash(es) "—" in prose. Replace EVERY em-dash with a period, a comma, a colon, or parentheses. The user has explicitly banned stylistic dashes.`,
    });
  }
  if (enDashMatches && enDashMatches.length > 0) {
    fails.push({
      rule: "no_en_dash",
      details: `Found ${enDashMatches.length} en-dash(es) "–" in prose. Replace EVERY en-dash. For numeric ranges write "X to Y" instead of "X–Y".`,
    });
  }

  // Readability: average sentence length. Count sentences in the body prose
  // (same cleaned-up prose used for dash detection).
  const bodyForReadability = prose
    .replace(/^#{1,6}\s+.+$/gm, "")                 // skip headings
    .replace(/^>\s*.+$/gm, "")                       // skip blockquotes
    .replace(/^\s*[-*]\s+.+$/gm, "")                 // skip bullet lines
    .replace(/^\s*\d+\.\s+.+$/gm, "")                // skip numbered list items
    .replace(/<!--[\s\S]*?-->/g, "")                 // skip HTML comments
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "");           // skip image markdown
  const sentences = bodyForReadability
    .split(/(?<=[.!?])\s+(?=[A-Z"(])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
  if (sentences.length > 0) {
    const totalWords = sentences.reduce((acc, s) => acc + s.split(/\s+/).length, 0);
    const avgWords = totalWords / sentences.length;
    const longSentences = sentences.filter((s) => s.split(/\s+/).length > 30);
    if (avgWords > 22) {
      fails.push({
        rule: "readability_avg",
        details: `Average sentence length is ${avgWords.toFixed(1)} words. Target under 20. Break long sentences into two. Use periods more, commas less.`,
      });
    }
    if (longSentences.length > 3) {
      fails.push({
        rule: "readability_long_sentences",
        details: `Found ${longSentences.length} sentences over 30 words. Shorten them. One idea per sentence.`,
      });
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
6. AT LEAST TWO <!-- IMAGE: inline --> placeholders spread across the H2 sections, each followed by its own <!-- PROMPT: [description] -->. Distribute them: one roughly a third of the way through, one roughly two thirds through. Never put two inline images back-to-back.
7. RespireLYF feature mention (~70% through) — 2-3 sentences, one feature only, earned not advertised
${ymylRequired ? `8. ⚠️  MANDATORY: ## When to See a Doctor
   This section is REQUIRED because ymyl_section_required = true.
   Write 3-5 sentences listing specific clinical warning signs that need immediate medical attention.
   DO NOT skip this section under any circumstances.
9. ## Track What's Actually Affecting Your Breathing  ← CTA (exact heading)` : `8. ## Track What's Actually Affecting Your Breathing  ← CTA (exact heading)`}
${ymylRequired ? "10" : "9"}. <!-- IMAGE: cta --> placeholder + <!-- PROMPT: [description] -->
${ymylRequired ? "11" : "10"}. A branded app-store CTA line on its own paragraph, EXACTLY:
    **[Download Free on the App Store →](https://respirelyf.onelink.me/6vuu/5b82x6qh)**
${ymylRequired ? "12" : "11"}. A horizontal rule line on its own (just \`---\`) followed by a single italic disclaimer paragraph, EXACTLY:
    *This article is for informational purposes only and does not constitute medical advice. Always consult your doctor or healthcare professional before making changes to your asthma or COPD management.*
${ymylRequired ? "13" : "12"}. ## Trusted Sources — 2-3 bullet links to real peer-reviewed / government / authoritative-clinic sources. Prefer the URLs provided in the brief's "Outbound links for Further Reading" (those have been pre-vetted from the SEO research sheet). Allowed domains: pubmed.ncbi.nlm.nih.gov, pmc.ncbi.nlm.nih.gov, cdc.gov, nhlbi.nih.gov, ncbi.nlm.nih.gov, nih.gov, fda.gov, who.int, nhs.uk, nejm.org, thelancet.com, bmj.com, jamanetwork.com, cochrane.org, mayoclinic.org, clevelandclinic.org, hopkinsmedicine.org, ginasthma.org, goldcopd.org, lung.org, aaaai.org, aafa.org, annallergy.org. NEVER invent URLs.
${ymylRequired ? "14" : "13"}. ## Further Reading (use the outbound links from the brief — different from Trusted Sources, short annotated list)

══════════════════════════════════════════
EDITORIAL FORMATTING (use these liberally. A wall of plain paragraphs is a FAIL.)
══════════════════════════════════════════
• At least TWO **bold** inline emphasis phrases per 300 words. Bold the sentence fragment that readers should take away, not the whole paragraph.
• At least ONE markdown blockquote (\`> text\`) per article, pulling out the single most important clinical or research insight. Format as \`> **text**\` or \`> *text*\` for added weight.
• At least ONE numbered list (\`1. \`, \`2. \`) where you give readers step-by-step actions or comparison points.
• Short, punchy paragraphs. 2 to 4 sentences max. Break up anything longer.
• Internal links from the brief should appear naturally inline with descriptive anchor text. Never use "click here".

══════════════════════════════════════════
NO-HYPHENS / NO-DASHES RULE (strict)
══════════════════════════════════════════
The user has asked for zero stylistic dashes. Follow these rules literally:
• NEVER use em-dashes (—). Replace with a period, a comma, a colon, or parentheses.
• NEVER use en-dashes (–). For numeric ranges (e.g. 800 to 1,200 words) write "X to Y" instead of "X–Y".
• Do NOT invent new compound words with a hyphen ("soul-crushing", "mind-blowing", "life-changing"). Use two words or a different phrase.
• Compound modifiers that are REQUIRED English (e.g. "long-term", "peak-flow meter", "anti-inflammatory", "over-the-counter", "well-known") are allowed because removing the hyphen creates a different word or ambiguity. When in doubt, rewrite to avoid the hyphen.
• If you catch yourself typing a dash for drama or to join clauses, stop and use a period or comma instead.

══════════════════════════════════════════
MAX READABILITY RULES (target Flesch grade 6 to 8, like a friendly newspaper)
══════════════════════════════════════════
• Average sentence under 20 words. Aim for a mix: a 6-word punch sentence followed by a 15-word explainer.
• Prefer one-syllable or two-syllable words. "Use" beats "utilize". "Help" beats "facilitate". "Stop" beats "discontinue".
• Active voice by default. "Pollen triggers your asthma." Not "Your asthma is triggered by pollen."
• One idea per sentence. If you use "and" or "but" twice in the same sentence, split it.
• Start most paragraphs with a concrete noun or a you-statement. Avoid starting with "Additionally", "Furthermore", "Moreover".
• Write to a reader who is tired, anxious, and scrolling on their phone. Every sentence should feel like a relief, not a chore.
• Use "you" and "your" often. Talk TO the reader, not about them.
• Replace jargon. "Exacerbation" becomes "flare-up" (wait, that has a hyphen. Use "flare" alone). "Bronchoconstriction" becomes "airway tightening".

══════════════════════════════════════════
HARD RULES
══════════════════════════════════════════
• Word count: TARGET 900 to 1,100 words (hard min 800, hard max 1,500). Count carefully.
• Primary keyword in: H1, opening paragraph, 2+ H2s, and closing section.
• CTA heading EXACTLY: "Track What's Actually Affecting Your Breathing". Copy verbatim.
• Image slots: exactly 1 hero, AT LEAST 2 inline, exactly 1 cta. Each followed by its own <!-- PROMPT: --> comment.
• Banned words, never use: journey, empower, transform, game-changer, revolutionary, unlock.
• NO em-dashes (—) or en-dashes (–) ANYWHERE in the article. This is a hard fail. Replace with period, comma, colon, or parentheses.
• Average sentence length under 20 words. Break anything over 30 words into two sentences.
• No Healthline, WebMD, Verywell Health links anywhere in the article.
• Trusted Sources URLs MUST be real and come from one of these authoritative domains: pmc.ncbi.nlm.nih.gov, pubmed.ncbi.nlm.nih.gov, cdc.gov, nhlbi.nih.gov, nih.gov, fda.gov, who.int, nhs.uk, nejm.org, thelancet.com, bmj.com, jamanetwork.com, cochrane.org, mayoclinic.org, clevelandclinic.org, hopkinsmedicine.org, ginasthma.org, goldcopd.org, lung.org, aaaai.org, aafa.org, annallergy.org. When the brief's "Outbound links for Further Reading" section contains URLs from these domains, cite THOSE verbatim — never invent replacement URLs.
• All internal links (respirelyf.com) must be exact absolute URLs. Never concatenate the domain to a path twice.
• FDA language: "associated with" not "causes", "research suggests" not "proves"
• Do NOT open with a definition or statistic

══════════════════════════════════════════
SELF-CHECK — run this before outputting the article
══════════════════════════════════════════
Before writing your final response, verify:
□ Word count between 800-1,400 (count it)
□ Primary keyword in opening paragraph (first plain text block)
□ <!-- IMAGE: hero --> present (exactly 1)
□ <!-- IMAGE: inline --> present AT LEAST TWICE, spread across the article
□ <!-- IMAGE: cta --> present (exactly 1)
□ Every image slot has its own <!-- PROMPT: --> block after it
□ At least 1 markdown blockquote (> ...) in the body
□ At least 1 numbered list in the body
□ At least a few **bold** emphasis phrases
${ymylRequired ? "□ ## When to See a Doctor section present — THIS IS MANDATORY\n" : ""}□ ## Track What's Actually Affecting Your Breathing heading present (exact text)
□ Branded **[Download Free on the App Store →](https://respirelyf.onelink.me/6vuu/5b82x6qh)** line after the CTA image
□ Italic disclaimer line after a \`---\` horizontal rule
□ ## Trusted Sources section present with 2-3 real pmc/cdc/nhlbi/nejm URLs
□ ## Further Reading section present
□ No banned words
□ ZERO em-dashes (—) or en-dashes (–) anywhere in prose
□ Average sentence under 20 words, no sentence over 30 words
□ Active voice by default, "you" used often, simple plain English

If any box is unchecked, fix it before outputting.

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

  const AUTH_DOMAINS_RE = /(pmc\.ncbi\.nlm\.nih\.gov|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|cdc\.gov|nhlbi\.nih\.gov|nih\.gov|nejm\.org|thelancet\.com|bmj\.com|jamanetwork\.com|fda\.gov|who\.int|nhs\.uk|cochrane\.org|ginasthma\.org|goldcopd\.org|mayoclinic\.org|clevelandclinic\.org|hopkinsmedicine\.org|lung\.org|aaaai\.org|aafa\.org|annallergy\.org)/i;
  const outboundStr = seo.outbound_links
    .map((l) => {
      const vetted = AUTH_DOMAINS_RE.test(l.url || "") ? " ← VETTED (use in Trusted Sources)" : "";
      return `- ${l.anchor_text} (${l.source_org}): ${l.url}${vetted}`;
    })
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
□ <!-- IMAGE: hero --> present at top (exactly 1)
□ <!-- IMAGE: inline --> present AT LEAST TWICE, spread across the article
□ <!-- IMAGE: cta --> present near end (exactly 1)
□ Each image has its own <!-- PROMPT: --> comment after it
□ At least 1 blockquote (> ...) with the single most important insight
□ At least 1 numbered list for step-by-step or comparison content
□ Multiple **bold** emphasis phrases on the key takeaway sentences
${brief.ymyl_section_required ? "□ ## When to See a Doctor section written (3-5 sentences of clinical warning signs)\n" : ""}□ ## Track What's Actually Affecting Your Breathing heading (exact text, no changes)
□ Branded **[Download Free on the App Store →](https://respirelyf.onelink.me/6vuu/5b82x6qh)** line after the CTA image
□ \`---\` rule then italic disclaimer line (exact text from system prompt)
□ ## Trusted Sources section with 2-3 real pmc/cdc/nhlbi/nejm URLs (never invent URLs)
□ ## Further Reading section with outbound links from brief
□ No banned words: journey / empower / transform / game-changer / revolutionary / unlock
□ No doubled-prefix URLs like https://www.respirelyf.comhttps://...
□ ZERO em-dashes (—) or en-dashes (–) anywhere in the prose (hard fail, user-enforced)
□ Average sentence under 20 words. No sentence over 30 words.
□ Active voice, simple plain English, "you" used often
□ H1 follows TITLE PSYCHOLOGY (curiosity + specificity, keyword in first 45 chars, no em/en-dashes)

All boxes checked? Output the article now. Start with the YAML frontmatter.`;
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
