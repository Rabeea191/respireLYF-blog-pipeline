/**
 * Topic-Brief Loader
 * ──────────────────────────────────────────────────────────────────────────
 * Bridges the SEO keyword sheet (via `pipeline/pick-topic.js`) with the
 * pipeline agents. When the user runs `node pick-topic.js --write "<keyword>"`,
 * a brief is written to `pipeline/topic-briefs/<slug>.md` containing:
 *   - The canonical primary keyword
 *   - Pre-curated authoritative source URLs (from the SEO sheet's Competitors /
 *     Content references columns, filtered by the authoritative-domain list)
 *   - Search metrics (volume, KD, CTR)
 *
 * The SEO Researcher agent calls `loadTopicBriefForKeyword()` after Claude
 * returns the initial SEOPackage, then merges the brief's authoritative
 * sources into `outbound_links` so the Blog Writer cites real, vetted URLs
 * instead of ones Claude hallucinates.
 *
 * Keeping this as plain filesystem I/O (no Claude call) means it's zero-cost
 * and deterministic — brief changes propagate to the next pipeline run.
 */

import fs from "fs";
import path from "path";

export interface TopicBriefSource {
  title: string;
  url: string;
  sourceOrg: string; // derived from hostname, e.g. "Cleveland Clinic", "Mayo Clinic"
}

export interface TopicBrief {
  slug: string;
  primaryKeyword: string;
  topic: string;              // "Topic / Page" field, e.g. "Cardiac-Related Cough"
  seedKeyword: string;
  volume: number;
  keywordDifficulty: number;
  clickPotential: number;
  intent: string;
  serpFeatures: string;
  trend: string;
  trustedSources: TopicBriefSource[]; // authoritative refs the writer should cite
  allReferences: TopicBriefSource[];  // full reference list for competitor reading
  rawPath: string;
}

// ─── Slugify (mirrors pick-topic.js) ──────────────────────────────────────────
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── Source-org inference from hostname ──────────────────────────────────────
const HOST_TO_ORG: Array<[RegExp, string]> = [
  [/(^|\.)clevelandclinic\.org$/, "Cleveland Clinic"],
  [/(^|\.)mayoclinic\.org$/, "Mayo Clinic"],
  [/(^|\.)hopkinsmedicine\.org$/, "Johns Hopkins Medicine"],
  [/(^|\.)cdc\.gov$/, "CDC"],
  [/(^|\.)nhlbi\.nih\.gov$/, "NHLBI"],
  [/(^|\.)pubmed\.ncbi\.nlm\.nih\.gov$/, "PubMed"],
  [/(^|\.)pmc\.ncbi\.nlm\.nih\.gov$/, "PMC / NCBI"],
  [/(^|\.)ncbi\.nlm\.nih\.gov$/, "NCBI"],
  [/(^|\.)nih\.gov$/, "NIH"],
  [/(^|\.)fda\.gov$/, "FDA"],
  [/(^|\.)who\.int$/, "WHO"],
  [/(^|\.)nhs\.uk$/, "NHS"],
  [/(^|\.)thelancet\.com$/, "Lancet"],
  [/(^|\.)nejm\.org$/, "NEJM"],
  [/(^|\.)bmj\.com$/, "BMJ"],
  [/(^|\.)jamanetwork\.com$/, "JAMA"],
  [/(^|\.)ginasthma\.org$/, "GINA"],
  [/(^|\.)goldcopd\.org$/, "GOLD"],
  [/(^|\.)lung\.org$/, "American Lung Association"],
  [/(^|\.)aaaai\.org$/, "AAAAI"],
  [/(^|\.)aafa\.org$/, "AAFA"],
  [/(^|\.)annallergy\.org$/, "Annals of Allergy"],
  [/(^|\.)cochrane\.org$/, "Cochrane"],
];

export function deriveSourceOrg(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const [re, org] of HOST_TO_ORG) {
      if (re.test(host)) return org;
    }
    return host;
  } catch {
    return "Unknown";
  }
}

// ─── Mirror the AUTHORITATIVE_DOMAINS list in pick-topic.js ──────────────────
const AUTHORITATIVE_DOMAINS = [
  "cdc.gov", "nih.gov", "nhlbi.nih.gov", "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov",
  "mayoclinic.org", "clevelandclinic.org", "hopkinsmedicine.org",
  "thelancet.com", "nejm.org", "bmj.com", "jamanetwork.com",
  "who.int", "nhs.uk", "cochrane.org", "ginasthma.org", "goldcopd.org",
  "fda.gov", "lung.org", "aaaai.org", "aafa.org", "annallergy.org",
];

export function isAuthoritativeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return AUTHORITATIVE_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

// ─── Brief parsing ───────────────────────────────────────────────────────────
// Briefs are written by pick-topic.js; we re-parse the exact layout it emits.

const SINGLE_LINE_FIELD = /^\*\*([^*:]+):\*\*\s*(.+)$/;

function parseMarkdownLink(line: string): { title: string; url: string } | null {
  // Matches `- [Title](https://url)` with optional trailing " ✅ authoritative"
  const m = line.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)/);
  if (!m) return null;
  return { title: m[1].trim(), url: m[2].trim() };
}

function parseMetric(line: string, label: string): string | null {
  // e.g. `- Monthly volume: **14,800**`  →  "14,800"
  const re = new RegExp("^-\\s*" + label + ":\\s*(?:\\*\\*)?([^*]+?)(?:\\*\\*)?\\s*$", "i");
  const m = line.match(re);
  return m ? m[1].trim() : null;
}

function intFromStr(s: string | null): number {
  if (!s) return 0;
  const m = s.replace(/,/g, "").match(/-?\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

export function parseTopicBrief(md: string, filePath: string): TopicBrief {
  const lines = md.split(/\r?\n/);

  // Section detection
  let currentSection: "header" | "metrics" | "trusted" | "allrefs" | "other" = "header";
  const fields: Record<string, string> = {};
  const metrics: Record<string, string> = {};
  const trustedRaw: Array<{ title: string; url: string }> = [];
  const allRaw: Array<{ title: string; url: string }> = [];

  for (const lineRaw of lines) {
    const line = lineRaw.trimEnd();
    if (/^##\s+.*Trusted Sources/i.test(line)) { currentSection = "trusted"; continue; }
    if (/^##\s+All content references/i.test(line)) { currentSection = "allrefs"; continue; }
    if (/^##\s+Search metrics/i.test(line))       { currentSection = "metrics"; continue; }
    if (/^##\s+/.test(line))                       { currentSection = "other"; continue; }

    // Header fields (above any ## heading)
    if (currentSection === "header") {
      const m = line.match(SINGLE_LINE_FIELD);
      if (m) {
        const key = m[1].trim().toLowerCase();
        let val = m[2].trim();
        // Strip enclosing backticks from slug field
        val = val.replace(/^`|`$/g, "");
        fields[key] = val;
      }
      continue;
    }

    if (currentSection === "metrics") {
      for (const label of [
        "Monthly volume", "Keyword difficulty", "Click potential",
        "Intent", "SERP features", "Trend",
      ]) {
        const v = parseMetric(line, label);
        if (v !== null) { metrics[label.toLowerCase()] = v; break; }
      }
      continue;
    }

    if (currentSection === "trusted") {
      const link = parseMarkdownLink(line);
      if (link) trustedRaw.push(link);
      continue;
    }

    if (currentSection === "allrefs") {
      const link = parseMarkdownLink(line);
      if (link) allRaw.push(link);
      continue;
    }
  }

  // Dedupe trusted by URL
  const seen = new Set<string>();
  const trustedSources: TopicBriefSource[] = [];
  for (const r of trustedRaw) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    trustedSources.push({ ...r, sourceOrg: deriveSourceOrg(r.url) });
  }
  const allReferences: TopicBriefSource[] = allRaw.map((r) => ({
    ...r,
    sourceOrg: deriveSourceOrg(r.url),
  }));

  return {
    slug: fields["slug"] || "",
    primaryKeyword: fields["primary keyword"] || "",
    topic: fields["topic / page"] || "",
    seedKeyword: fields["seed keyword"] || "",
    volume: intFromStr(metrics["monthly volume"]),
    keywordDifficulty: intFromStr(metrics["keyword difficulty"]),
    clickPotential: intFromStr(metrics["click potential"]),
    intent: metrics["intent"] || "",
    serpFeatures: metrics["serp features"] || "",
    trend: metrics["trend"] || "",
    trustedSources,
    allReferences,
    rawPath: filePath,
  };
}

// ─── Resolve the briefs directory (relative to pipeline/ root) ───────────────
function briefsDir(): string {
  // This file lives at pipeline/src/lib/topic-brief.ts (or dist/src/lib/...)
  // Walk up looking for a directory that contains a `topic-briefs` sibling.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "topic-briefs");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume cwd/topic-briefs (matches how pick-topic.js is invoked)
  return path.join(process.cwd(), "topic-briefs");
}

// ─── Load a brief by slug or keyword ─────────────────────────────────────────
export function loadTopicBriefBySlug(slug: string): TopicBrief | null {
  if (!slug) return null;
  const briefPath = path.join(briefsDir(), `${slug}.md`);
  if (!fs.existsSync(briefPath)) return null;
  try {
    const raw = fs.readFileSync(briefPath, "utf-8");
    return parseTopicBrief(raw, briefPath);
  } catch {
    return null;
  }
}

export function loadTopicBriefForKeyword(keyword: string): TopicBrief | null {
  if (!keyword) return null;
  return loadTopicBriefBySlug(slugify(keyword));
}

// ─── Merge: prepend brief's authoritative sources into SEO outbound_links ───
// Rule: preserve any links Claude added that are ALSO authoritative (by URL),
// but put the brief's vetted sources first (they're hand-curated from SERPs).
export function mergeOutboundLinks(
  existing: Array<{ anchor_text: string; url: string; source_org: string }>,
  brief: TopicBrief,
  maxTotal = 4,
): Array<{ anchor_text: string; url: string; source_org: string }> {
  const seen = new Set<string>();
  const out: Array<{ anchor_text: string; url: string; source_org: string }> = [];

  // First: brief-curated authoritative sources
  for (const s of brief.trustedSources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ anchor_text: s.title, url: s.url, source_org: s.sourceOrg });
    if (out.length >= maxTotal) return out;
  }

  // Then: existing links that Claude suggested, if authoritative and not already present
  for (const link of existing) {
    if (!link?.url || seen.has(link.url)) continue;
    if (!isAuthoritativeUrl(link.url)) continue;
    seen.add(link.url);
    out.push(link);
    if (out.length >= maxTotal) return out;
  }

  // Finally: fall back to any remaining existing links if we have < 2
  if (out.length < 2) {
    for (const link of existing) {
      if (!link?.url || seen.has(link.url)) continue;
      seen.add(link.url);
      out.push(link);
      if (out.length >= maxTotal) return out;
    }
  }

  return out;
}
