#!/usr/bin/env node
/**
 * pick-topic.js  —  Surface the next highest-ROI blog opportunity from the
 * curated SEO keyword sheet.
 *
 * Inputs:
 *   - "Master Sheet for SEO - website ranking keywords.csv" in this folder
 *   - Existing blog slugs in ./blogs/<slug>/
 *
 * Outputs:
 *   - Prints a ranked list of top uncovered winnable keywords to stdout.
 *   - Optionally writes ./topic-briefs/<slug>.md with primary keyword,
 *     secondary keywords, content references (seed Trusted Sources),
 *     volume/KD metadata — ready to be fed into the blog writer.
 *
 * Usage:
 *   node pick-topic.js                        # list top 20 opportunities
 *   node pick-topic.js --top 40               # list top 40
 *   node pick-topic.js --write "peak flow meter"   # write a brief for that keyword
 *   node pick-topic.js --all                  # include harder keywords (KD up to 60)
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const CSV_PATH   = path.join(__dirname, "Master Sheet for SEO - website ranking keywords.csv");
const BLOGS_DIR  = path.join(__dirname, "blogs");
const BRIEFS_DIR = path.join(__dirname, "topic-briefs");

// ─── Minimal CSV parser (handles quoted fields with embedded commas/newlines) ──
function parseCSV(text) {
  const rows = [];
  let cur = [""];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') { cur[cur.length - 1] += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur[cur.length - 1] += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") cur.push("");
      else if (c === "\n") { rows.push(cur); cur = [""]; }
      else if (c === "\r") { /* skip */ }
      else cur[cur.length - 1] += c;
    }
  }
  if (cur.length > 1 || cur[0] !== "") rows.push(cur);
  if (!rows.length) return [];
  const header = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.some(v => v && v.trim() !== ""))
    .map(r => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
      return obj;
    });
}

function parseIntSafe(v) {
  if (typeof v !== "string") return 0;
  const m = v.replace(/,/g, "").match(/-?\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// ─── Parse "Content references" cell → array of { title, url } ────────────────
// Cells look like:   "Title A":"https://x",\n"Title B":"https://y"
function parseContentRefs(cell) {
  if (!cell) return [];
  const out = [];
  const re = /"([^"]+)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(cell)) !== null) {
    out.push({ title: m[1].trim(), url: m[2].trim() });
  }
  return out;
}

// ─── Slug helper ─────────────────────────────────────────────────────────────
function slugify(s) {
  return s.toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── Rank a row: higher = more attractive opportunity ────────────────────────
function rankScore(row) {
  const vol = parseIntSafe(row.Volume);
  const kd  = parseIntSafe(row["Keyword Difficulty"]);
  const ctr = parseIntSafe(row["Click potential"]);
  if (!vol) return 0;
  // Score favors volume, penalizes difficulty, rewards click potential
  const difficultyPenalty = Math.max(0, (kd - 20)) * 15; // every KD point above 20 costs volume-equivalent
  const clickBonus = ctr; // 0-100
  return Math.round(vol - difficultyPenalty + clickBonus);
}

// ─── Load existing slugs (published + drafted) ───────────────────────────────
function loadExistingSlugs() {
  const slugs = new Set();
  if (fs.existsSync(BLOGS_DIR)) {
    for (const entry of fs.readdirSync(BLOGS_DIR)) {
      if (fs.statSync(path.join(BLOGS_DIR, entry)).isDirectory()) slugs.add(entry);
    }
  }
  return slugs;
}

// ─── Trusted Sources filter: only keep authoritative medical/research URLs ──
const AUTHORITATIVE_DOMAINS = [
  "cdc.gov", "nih.gov", "nhlbi.nih.gov", "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov",
  "mayoclinic.org", "clevelandclinic.org", "hopkinsmedicine.org",
  "thelancet.com", "nejm.org", "bmj.com", "jamanetwork.com",
  "who.int", "nhs.uk", "cochrane.org", "ginasthma.org", "goldcopd.org",
  "fda.gov", "lung.org", "aaaai.org", "aafa.org", "annallergy.org",
];

function isAuthoritative(url) {
  try {
    const u = new URL(url);
    return AUTHORITATIVE_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith("." + d));
  } catch { return false; }
}

// ─── Main: list or write ─────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const topIdx = args.indexOf("--top");
  const top = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : 20;
  const writeIdx = args.indexOf("--write");
  const writeKw = writeIdx !== -1 ? args[writeIdx + 1] : null;
  const includeHard = args.includes("--all");

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌ CSV not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = parseCSV(raw);
  console.log(`📊 Loaded ${rows.length} rows from SEO sheet.`);

  const existing = loadExistingSlugs();
  console.log(`📁 Found ${existing.size} existing blog slug(s): ${[...existing].join(", ") || "(none)"}`);

  const maxKD = includeHard ? 60 : 45;
  const candidates = rows
    .filter(r => {
      const vol    = parseIntSafe(r.Volume);
      const kd     = parseIntSafe(r["Keyword Difficulty"]);
      const intent = (r.Intent || "").toLowerCase();
      const kw     = (r.Keyword || "").trim();
      if (!kw) return false;
      if (vol < 300) return false;
      if (kd === 0) return false;               // blank KD → not researched
      if (kd > maxKD) return false;
      if (!intent.includes("informational")) return false;
      // Skip already-covered (fuzzy: slug of keyword matches any existing slug)
      const kwSlug = slugify(kw);
      for (const s of existing) {
        if (s === kwSlug) return false;
        // fuzzy: existing slug shares the main keyword's core noun
        if (kwSlug.includes(s) || s.includes(kwSlug)) return false;
      }
      return true;
    })
    .map(r => ({ ...r, _score: rankScore(r) }))
    .sort((a, b) => b._score - a._score);

  console.log(`\n🎯 ${candidates.length} uncovered informational opportunities (KD ≤ ${maxKD}, vol ≥ 300).\n`);

  if (writeKw) {
    const pick = candidates.find(r => r.Keyword.toLowerCase() === writeKw.toLowerCase())
              || rows.find(r => (r.Keyword || "").toLowerCase() === writeKw.toLowerCase());
    if (!pick) {
      console.error(`❌ Keyword "${writeKw}" not found in the sheet.`);
      process.exit(1);
    }
    writeBrief(pick);
    return;
  }

  console.log(`${"VOL".padStart(6)}  ${"KD".padStart(3)}  ${"CTR".padStart(3)}  ${"SCORE".padStart(6)}  ${"KEYWORD".padEnd(45)}  TOPIC`);
  console.log("─".repeat(120));
  for (const c of candidates.slice(0, top)) {
    const vol = parseIntSafe(c.Volume);
    const kd  = parseIntSafe(c["Keyword Difficulty"]);
    const ctr = parseIntSafe(c["Click potential"]);
    const topic = c.Topic || c["Page Name"] || "(no topic)";
    console.log(
      `${String(vol).padStart(6)}  ${String(kd).padStart(3)}  ${String(ctr).padStart(3)}  ${String(c._score).padStart(6)}  ${c.Keyword.padEnd(45).slice(0, 45)}  ${topic}`
    );
  }
  console.log(`\n💡 Write a brief for the top opportunity:`);
  console.log(`   node pick-topic.js --write "${candidates[0]?.Keyword || "<keyword>"}"`);
  console.log();
}

function writeBrief(row) {
  const kw  = row.Keyword.trim();
  const slug = slugify(kw);
  const vol = parseIntSafe(row.Volume);
  const kd  = parseIntSafe(row["Keyword Difficulty"]);
  const ctr = parseIntSafe(row["Click potential"]);
  // NB: the sheet's authoritative URLs live in the "Competitors" column in
  // this CSV, with "Content references" often empty. Read both and merge.
  const refsContent = parseContentRefs(row["Content references"] || "");
  const refsCompetitors = parseContentRefs(row["Competitors"] || "");
  const seen = new Set();
  const refs = [...refsContent, ...refsCompetitors].filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  const trusted = refs.filter(r => isAuthoritative(r.url));
  const allRefs = refs;

  if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const briefPath = path.join(BRIEFS_DIR, `${slug}.md`);

  const lines = [
    `# Blog Brief — ${kw}`,
    ``,
    `**Slug:** \`${slug}\``,
    `**Primary keyword:** ${kw}`,
    `**Topic / Page:** ${row.Topic || row["Page Name"] || "(unassigned)"}`,
    `**Seed keyword:** ${row["Seed keyword"] || "(none)"}`,
    ``,
    `## Search metrics (from SEO sheet)`,
    ``,
    `- Monthly volume: **${vol.toLocaleString()}**`,
    `- Keyword difficulty: **${kd}**`,
    `- Click potential: **${ctr}**`,
    `- Intent: ${row.Intent || "(unknown)"}`,
    `- SERP features: ${row["SERP Features"] || "(none listed)"}`,
    `- Trend: ${row.Trend || "(no trend data)"}`,
    ``,
    `## Trusted Sources — authoritative (use 2–3 in Further Reading)`,
    ``,
    trusted.length
      ? trusted.map(r => `- [${r.title}](${r.url})`).join("\n")
      : `_No authoritative references in the sheet for this keyword — writer must research fresh from cdc.gov / nhlbi.nih.gov / pubmed.ncbi.nlm.nih.gov / mayoclinic.org._`,
    ``,
    `## All content references from the sheet (for competitor reading, not citation)`,
    ``,
    allRefs.length
      ? allRefs.map(r => `- [${r.title}](${r.url})${isAuthoritative(r.url) ? " ✅ authoritative" : ""}`).join("\n")
      : `_(none)_`,
    ``,
    `## Writer instructions`,
    ``,
    `- Target this exact primary keyword in the H1, first paragraph, and meta title: **${kw}**`,
    `- Aim for 1,200–1,600 words, patient-centered, informational intent`,
    `- Include 2 \`<!-- IMAGE: inline -->\` markers and 1 \`<!-- IMAGE: cta -->\` marker`,
    `- Cite 2–3 of the authoritative Trusted Sources above in the \`## Trusted Sources\` section`,
    `- Mention RespireLYF's relevant feature naturally once (not as an ad)`,
    `- End with the standard disclaimer + CTA button`,
    ``,
  ];

  fs.writeFileSync(briefPath, lines.join("\n"));
  console.log(`✅ Brief written → ${briefPath}`);
  console.log(`   Volume: ${vol.toLocaleString()}  |  KD: ${kd}  |  Authoritative sources: ${trusted.length}`);
  console.log(`\nNext step: feed this brief into the blog writer, then:`);
  console.log(`   node post-blog.js --slug ${slug}`);
}

main();
