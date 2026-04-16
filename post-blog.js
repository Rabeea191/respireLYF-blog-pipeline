#!/usr/bin/env node
/**
 * post-blog.js  —  plain Node.js, no TypeScript compilation needed
 *
 * Reads the most recent blog from blogs/ and posts it to Payload CMS.
 *
 * Run:  node post-blog.js
 *   or: node post-blog.js --slug why-your-asthma-gets-worse-every-spring
 */

"use strict";
const fs   = require("fs");
const path = require("path");

// ─── Load .env manually (no dotenv dependency needed) ──────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const PAYLOAD_URL      = process.env.PAYLOAD_URL      || "http://localhost:3000";
const PAYLOAD_EMAIL    = process.env.PAYLOAD_EMAIL    || "";
const PAYLOAD_PASSWORD = process.env.PAYLOAD_PASSWORD || "";

if (!PAYLOAD_PASSWORD) {
  console.error("❌  PAYLOAD_PASSWORD not set in .env");
  process.exit(1);
}

// ─── Word count ─────────────────────────────────────────────────────────────
function countWords(md) {
  return md
    .replace(/^---[\s\S]+?---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/#{1,6}\s/g, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

// ─── Parse YAML frontmatter ─────────────────────────────────────────────────
function parseFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]+?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = val;
  }
  return meta;
}

// ─── Markdown → Payload Lexical JSON ───────────────────────────────────────
function genId() {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
function textNode(text, format = 0) {
  return { detail: 0, format, mode: "normal", style: "", text, type: "text", version: 1 };
}
function paragraphNode(children) {
  return { children, direction: null, format: "", indent: 0, type: "paragraph", version: 1, textFormat: 0, textStyle: "" };
}
function headingNode(children, tag) {
  return { children, direction: null, format: "", indent: 0, type: "heading", version: 1, textFormat: 1, tag };
}
function listItemNode(children, value) {
  return { children, direction: null, format: "", indent: 0, type: "listitem", version: 1, value };
}
function listNode(items, listType) {
  return {
    children: items.map((c, i) => listItemNode(c, i + 1)),
    direction: null, format: "", indent: 0, type: "list", version: 1,
    listType, start: 1, tag: listType === "bullet" ? "ul" : "ol",
  };
}
function linkNode(children, url) {
  return {
    children, direction: null, format: "", indent: 0, type: "link", version: 3, textFormat: 0,
    fields: { url, linkType: "custom" }, id: genId(),
  };
}
function parseInline(text) {
  const nodes = [];
  const regex = /(\[([^\]]+)\]\(([^)]+)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|([^*\[]+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2] !== undefined) nodes.push(linkNode([textNode(match[2])], match[3]));
    else if (match[4] !== undefined) nodes.push(textNode(match[4], 3));
    else if (match[5] !== undefined) nodes.push(textNode(match[5], 1));
    else if (match[6] !== undefined) nodes.push(textNode(match[6], 2));
    else if (match[7] !== undefined) nodes.push(textNode(match[7], 0));
  }
  return nodes.length ? nodes : [textNode(text, 0)];
}

function markdownToLexical(body) {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
  const lines = cleaned.split("\n");
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const trim = lines[i].trimEnd().trim();
    if (!trim) { i++; continue; }

    // skip image placeholders
    if (trim.match(/^<!--\s*IMAGE:/)) { i++; continue; }
    if (trim === "---") { i++; continue; }

    const hm = trim.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      nodes.push(headingNode(parseInline(hm[2]), `h${hm[1].length}`));
      i++; continue;
    }
    if (trim.match(/^[-*]\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].trimEnd().trim().match(/^[-*]\s+/)) {
        items.push(parseInline(lines[i].trimEnd().trim().replace(/^[-*]\s+/, "")));
        i++;
      }
      nodes.push(listNode(items, "bullet")); continue;
    }
    if (trim.match(/^\d+\.\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].trimEnd().trim().match(/^\d+\.\s+/)) {
        items.push(parseInline(lines[i].trimEnd().trim().replace(/^\d+\.\s+/, "")));
        i++;
      }
      nodes.push(listNode(items, "number")); continue;
    }
    nodes.push(paragraphNode(parseInline(trim)));
    i++;
  }
  return { root: { children: nodes, direction: null, format: "", indent: 0, type: "root", version: 1 } };
}

// ─── Payload API calls ──────────────────────────────────────────────────────
async function login() {
  const res = await fetch(`${PAYLOAD_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PAYLOAD_EMAIL, password: PAYLOAD_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

async function createDraft(token, meta, content) {
  const body = {
    title:         meta.meta_title   || meta.title || "Untitled",
    slug:          meta.slug,
    content,
    _status:       "draft",
    publishedDate: new Date().toISOString(),
    excerpt:       meta.meta_description || "",
    seo: {
      metaTitle:         meta.meta_title       || "",
      metaDescription:   meta.meta_description || "",
      primaryKeywords:   meta.primary_keyword  || "",
      secondaryKeywords: meta.secondary_keywords || "",
    },
  };
  const res = await fetch(`${PAYLOAD_URL}/api/blog?depth=0&fallback-locale=null`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `JWT ${token}` },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(`Create failed: ${JSON.stringify(result.errors || result)}`);
  const id = result.doc?.id || result.id;
  return { id, adminUrl: `${PAYLOAD_URL}/admin/collections/blog/${id}` };
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n=== Post Blog → Payload CMS ===\n");

  const blogsDir = path.join(__dirname, "blogs");

  // Determine slug
  let slug = "";
  const slugIdx = process.argv.indexOf("--slug");
  if (slugIdx !== -1 && process.argv[slugIdx + 1]) {
    slug = process.argv[slugIdx + 1];
    console.log(`Slug: ${slug}`);
  } else {
    if (!fs.existsSync(blogsDir)) {
      console.error("❌  No blogs/ folder. Run npm run tier2 first.");
      process.exit(1);
    }
    const folders = fs.readdirSync(blogsDir)
      .filter(f => fs.statSync(path.join(blogsDir, f)).isDirectory())
      .sort((a, b) =>
        fs.statSync(path.join(blogsDir, b)).mtimeMs -
        fs.statSync(path.join(blogsDir, a)).mtimeMs
      );
    if (!folders.length) { console.error("❌  No blog folders found."); process.exit(1); }
    slug = folders[0];
    console.log(`Auto-detected: ${slug}`);
  }

  const mdPath = path.join(blogsDir, slug, `${slug}.md`);
  if (!fs.existsSync(mdPath)) {
    console.error(`❌  File not found: ${mdPath}`);
    process.exit(1);
  }

  const markdown = fs.readFileSync(mdPath, "utf-8");
  const meta     = parseFrontmatter(markdown);
  const words    = countWords(markdown);
  console.log(`📄  "${meta.meta_title || slug}"  (${words} words)`);

  // Strip frontmatter for Lexical conversion
  const body = markdown.replace(/^---[\s\S]+?---\n/, "");
  const content = markdownToLexical(body);

  console.log(`🚀  Posting to ${PAYLOAD_URL}…\n`);

  const token = await login();
  const { id, adminUrl } = await createDraft(token, meta, content);

  console.log("✅  SUCCESS");
  console.log(`    Payload draft : ${adminUrl}`);
  console.log(`    Slug          : ${slug}\n`);
}

main().catch(err => {
  console.error("\n❌  Error:", err.message);
  process.exit(1);
});
