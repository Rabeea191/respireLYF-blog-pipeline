/**
 * Stage 6 — SEO Research Agent
 *
 * For each approved topic, builds a full SEO package:
 *   - Primary keyword confirmed with difficulty estimate
 *   - 4–5 secondary keywords (patient-language)
 *   - Top 3 competitor URLs with gap analysis
 *   - Suggested H2 outline (3–5 headings)
 *   - 1–3 internal links to existing RespireLYF blogs
 *   - 2 authoritative outbound links (CDC/NIH/NHLBI/GINA/GOLD only)
 *   - YMYL confirmation
 *
 * Uses SerpAPI for competitor URLs + Claude for gap analysis & keyword research.
 */

import axios from "axios";
import { callClaudeJSON } from "../lib/claude";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import {
  loadTopicBriefForKeyword,
  loadTopicBriefBySlug,
  mergeOutboundLinks,
  slugify,
} from "../lib/topic-brief";
import type { TopicCard, SEOPackage, AgentResult } from "../types";
import { randomUUID } from "crypto";

// ─── Published blog slugs for internal linking ───────────────────────────────
// These are updated manually or fetched from Payload — add as published
const PUBLISHED_BLOGS: Array<{ slug: string; title: string; url: string }> = [
  { slug: "foods-that-trigger-asthma", title: "Foods That Trigger Asthma", url: "/blog/foods-that-trigger-asthma" },
  { slug: "asthma-worse-at-night", title: "Why Does Asthma Get Worse at Night?", url: "/blog/asthma-worse-at-night" },
  { slug: "stress-and-asthma", title: "Does Stress Make Asthma Worse?", url: "/blog/stress-and-asthma" },
  { slug: "copd-cold-weather", title: "COPD and Cold Weather", url: "/blog/copd-cold-weather" },
  { slug: "peak-flow-reading", title: "How to Read Your Peak Flow Results", url: "/blog/peak-flow-reading" },
];

const PROHIBITED_OUTBOUND = ["healthline", "verywellhealth", "webmd", "medicalnewstoday", "everyday health"];
const APPROVED_OUTBOUND_ORGS = ["CDC", "NIH", "NHLBI", "GINA", "GOLD", "FDA", "AJRCCM", "NEJM", "JAMA", "Chest", "Lancet"];

// ─── SerpAPI competitor search ─────────────────────────────────────────────
async function fetchCompetitorUrls(keyword: string): Promise<string[]> {
  if (!config.serpApi.key) {
    logger.warn("seo-researcher", "SERP_API_KEY missing — skipping competitor fetch");
    return [];
  }

  try {
    const res = await axios.get("https://serpapi.com/search", {
      params: {
        q: keyword,
        api_key: config.serpApi.key,
        engine: "google",
        gl: "us",
        hl: "en",
        num: 10,
      },
      timeout: 15_000,
    });

    const organic: any[] = res.data?.organic_results ?? [];
    const urls = organic
      .map((r: any) => r.link as string)
      .filter((url) => !PROHIBITED_OUTBOUND.some((d) => url.toLowerCase().includes(d)))
      .slice(0, 5);

    return urls;
  } catch (err: any) {
    logger.error("seo-researcher", `SerpAPI fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Claude SEO research call ──────────────────────────────────────────────
const SEO_SYSTEM_PROMPT = `You are an expert SEO researcher for RespireLYF — an iOS respiratory health app for US adults with asthma or COPD.

Your job: produce a complete SEO research package for a blog topic.

APPROVED OUTBOUND ORGANIZATIONS: ${APPROVED_OUTBOUND_ORGS.join(", ")}
PROHIBITED SOURCES: Healthline, Verywell Health, WebMD, MedicalNewsToday (competitors)
INTERNAL BLOG BASE URL: https://www.respirelyf.com

RULES:
1. secondary_keywords must be patient-language phrases (how they search, not medical jargon)
2. H2 outline must cover what top-ranking pages cover PLUS one section they're missing
3. outbound_links must be real, existing URLs from the approved orgs above
4. internal_links should only reference blogs from the published list provided
5. keyword_difficulty_estimate based on search competition signal (low/medium/high)
6. gap_note per competitor: what specific angle is missing that we can own

Return ONLY valid JSON matching the SEOPackage shape exactly.`;

interface SEOPackageRaw {
  primary_keyword: string;
  secondary_keywords: string[];
  keyword_difficulty_estimate: "low" | "medium" | "high";
  competitor_urls: Array<{ url: string; gap_note: string }>;
  suggested_h2_outline: string[];
  internal_links: Array<{ anchor_text: string; url: string }>;
  outbound_links: Array<{ anchor_text: string; url: string; source_org: string }>;
  ymyl_confirmed: boolean;
}

async function buildSEOPackage(
  topic: TopicCard,
  competitorUrls: string[]
): Promise<SEOPackageRaw> {
  const prompt = `Topic: "${topic.title}"
Primary keyword: "${topic.primary_keyword}"
YMYL flag: ${topic.ymyl_flag}
RespireLYF feature: ${topic.respireLYF_feature}
Rationale: ${topic.rationale}

Competitor URLs found for this keyword:
${competitorUrls.length > 0 ? competitorUrls.map((u, i) => `${i + 1}. ${u}`).join("\n") : "None found — use your knowledge of typical top-ranking pages for this query"}

Published internal blogs available for linking:
${PUBLISHED_BLOGS.map((b) => `- "${b.title}" → ${b.url}`).join("\n")}

Build the complete SEO package. Include:
- 4-5 secondary_keywords (patient-language)
- 3 competitor_urls with gap_note each (use the URLs above where available)
- 4 suggested_h2_outline entries (3 that top pages cover + 1 unique angle we can own)
- 1-2 internal_links from the published blogs list (only if genuinely relevant)
- 2 outbound_links from approved organizations with real existing URLs
- ymyl_confirmed based on whether this topic covers symptoms/flares/worsening`;

  return callClaudeJSON<SEOPackageRaw>(
    SEO_SYSTEM_PROMPT,
    prompt,
    "claude-sonnet-4-6"
  );
}

// ─── Validate SEO package ──────────────────────────────────────────────────
function validateSEOPackage(pkg: SEOPackageRaw): string[] {
  const errors: string[] = [];

  if (!pkg.primary_keyword) errors.push("Missing primary_keyword");
  if ((pkg.secondary_keywords ?? []).length < 3)
    errors.push(`Only ${pkg.secondary_keywords?.length ?? 0} secondary keywords — need 3+`);
  if ((pkg.suggested_h2_outline ?? []).length < 3)
    errors.push("Less than 3 H2 headings suggested");
  if ((pkg.outbound_links ?? []).length < 1)
    errors.push("No outbound links — need at least 1 from approved orgs");
  if ((pkg.outbound_links ?? []).some((l) =>
    PROHIBITED_OUTBOUND.some((d) => l.url?.toLowerCase().includes(d))
  )) errors.push("Prohibited source in outbound_links");
  if ((pkg.internal_links ?? []).length > 3)
    errors.push("Too many internal links — max 3");

  return errors;
}

// ─── Main export ───────────────────────────────────────────────────────────
export async function runSEOResearcher(
  topic: TopicCard
): Promise<AgentResult<SEOPackage>> {
  const start = Date.now();

  return logger.timed("seo-researcher", `Researching "${topic.title}"`, async () => {
    // Step 0: look up a pre-curated topic brief from the SEO sheet (written by
    // `node pick-topic.js --write "<keyword>"`). If present we use its real
    // search metrics + authoritative URLs instead of having Claude invent them.
    const brief =
      loadTopicBriefForKeyword(topic.primary_keyword) ||
      loadTopicBriefBySlug(slugify(topic.title));

    if (brief) {
      logger.info(
        "seo-researcher",
        `📎 Topic brief loaded from ${brief.rawPath} — vol=${brief.volume}, KD=${brief.keywordDifficulty}, ${brief.trustedSources.length} authoritative sources`
      );
    }

    // Step 1: fetch competitor URLs from SerpAPI
    const competitorUrls = await fetchCompetitorUrls(topic.primary_keyword);
    logger.info("seo-researcher", `Found ${competitorUrls.length} competitor URLs`);

    // Step 2: Claude builds the full SEO package
    let raw: SEOPackageRaw;
    try {
      raw = await buildSEOPackage(topic, competitorUrls);
    } catch (err: any) {
      return {
        success: false,
        error: `Claude SEO research failed: ${err.message}`,
        iteration: 1,
        duration_ms: Date.now() - start,
      };
    }

    // Step 3: validate
    const errors = validateSEOPackage(raw);
    if (errors.length > 0) {
      logger.warn("seo-researcher", `Validation issues: ${errors.join("; ")}`);
      // Non-fatal — log and continue with what we have
    }

    // Build the initial SEO package from Claude's output (pre-brief merge).
    const seoPackage: SEOPackage = {
      topic_id: topic.id,
      primary_keyword: raw.primary_keyword ?? topic.primary_keyword,
      secondary_keywords: raw.secondary_keywords ?? [],
      keyword_difficulty_estimate: raw.keyword_difficulty_estimate ?? "medium",
      competitor_urls: raw.competitor_urls ?? [],
      suggested_h2_outline: raw.suggested_h2_outline ?? [],
      internal_links: raw.internal_links ?? [],
      outbound_links: (raw.outbound_links ?? []) as any,
      ymyl_confirmed: raw.ymyl_confirmed ?? topic.ymyl_flag,
      researched_at: new Date().toISOString(),
    };

    // Step 4: if a topic brief exists, override with its vetted data.
    // The brief carries: (a) the canonical primary keyword from the SEO sheet,
    // (b) a pre-curated list of authoritative URLs, and (c) a real KD estimate.
    if (brief) {
      // Primary keyword — prefer the brief (matches what ranked in the CSV).
      if (brief.primaryKeyword) seoPackage.primary_keyword = brief.primaryKeyword;

      // Keyword difficulty — map the numeric KD to the low/medium/high bucket.
      if (brief.keywordDifficulty > 0) {
        seoPackage.keyword_difficulty_estimate =
          brief.keywordDifficulty < 30 ? "low" :
          brief.keywordDifficulty < 50 ? "medium" : "high";
      }

      // Outbound links — prepend brief's hand-curated authoritative sources.
      // mergeOutboundLinks keeps Claude-suggested authoritative URLs too, so we
      // retain the breadth while anchoring on the vetted ones.
      const merged = mergeOutboundLinks(
        seoPackage.outbound_links as any,
        brief,
        4
      );
      if (merged.length > 0) {
        seoPackage.outbound_links = merged as any;
        logger.info(
          "seo-researcher",
          `🔗 Outbound links: ${merged.length} total (${brief.trustedSources.length} from brief, rest from Claude)`
        );
      }

      // Competitor URLs — if Claude returned none, seed from the brief's
      // content references so the gap-analysis isn't empty on rerun.
      if (!seoPackage.competitor_urls?.length && brief.allReferences.length > 0) {
        seoPackage.competitor_urls = brief.allReferences.slice(0, 3).map((r) => ({
          url: r.url,
          gap_note: `Seeded from SEO brief (${r.sourceOrg}); verify specific angle gap manually.`,
        }));
      }
    }

    logger.info("seo-researcher", `SEO package ready — ${seoPackage.secondary_keywords.length} secondary keywords, ${seoPackage.suggested_h2_outline.length} H2s${brief ? ", brief merged" : ""}`);

    return {
      success: true,
      data: seoPackage,
      iteration: 1,
      duration_ms: Date.now() - start,
    };
  });
}
