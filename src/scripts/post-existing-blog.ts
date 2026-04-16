/**
 * post-existing-blog.ts
 *
 * Re-posts an already-written blog (saved in blogs/ folder) to Payload CMS
 * without running the full Tier 2 pipeline again.
 *
 * Usage:
 *   npm run post-blog                  ← posts the latest written blog
 *   npm run post-blog -- --slug why-your-asthma-gets-worse-every-spring
 */

import { config as dotenvConfig } from "dotenv";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { runPayloadPoster } from "../agents/payload-poster";
import type { BlogDraft, ContentBrief, TopicCard } from "../types";

dotenvConfig({ path: path.join(process.cwd(), ".env") });

// ─── Helpers ────────────────────────────────────────────────────────────────

function countWords(markdown: string): number {
  const noFront = markdown.replace(/^---[\s\S]+?---\n/, "");
  const noComments = noFront.replace(/<!--[\s\S]*?-->/g, "");
  const plain = noComments
    .replace(/#{1,6}\s/g, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
  return plain.split(/\s+/).filter(Boolean).length;
}

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]+?)\n---/);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }
  return meta;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Post Existing Blog → Payload CMS ===\n");

  const blogsDir = path.join(process.cwd(), "blogs");
  const dataDir  = path.join(process.cwd(), "pipeline-data");

  // Determine which slug to post
  let slug = "";
  const slugArg = process.argv.findIndex((a) => a === "--slug");
  if (slugArg !== -1 && process.argv[slugArg + 1]) {
    slug = process.argv[slugArg + 1];
    console.log(`Using slug from --slug arg: ${slug}`);
  } else {
    // Auto-detect: find most recently modified blog folder
    if (!fs.existsSync(blogsDir)) {
      console.error("❌ No blogs/ folder found. Run npm run tier2 first.");
      process.exit(1);
    }
    const folders = fs.readdirSync(blogsDir)
      .filter((f) => fs.statSync(path.join(blogsDir, f)).isDirectory())
      .sort((a, b) => {
        const aTime = fs.statSync(path.join(blogsDir, a)).mtimeMs;
        const bTime = fs.statSync(path.join(blogsDir, b)).mtimeMs;
        return bTime - aTime; // newest first
      });
    if (folders.length === 0) {
      console.error("❌ No blog folders found in blogs/");
      process.exit(1);
    }
    slug = folders[0];
    console.log(`Auto-detected most recent blog: ${slug}`);
  }

  // Read the markdown file
  const mdPath = path.join(blogsDir, slug, `${slug}.md`);
  if (!fs.existsSync(mdPath)) {
    console.error(`❌ Blog file not found: ${mdPath}`);
    process.exit(1);
  }

  const markdown = fs.readFileSync(mdPath, "utf-8");
  const fm = parseFrontmatter(markdown);
  const wordCount = countWords(markdown);
  console.log(`📄 Blog: "${fm["meta_title"] ?? slug}" (${wordCount} words)\n`);

  // Build a minimal BlogDraft from the saved file
  const draft: BlogDraft = {
    id:               randomUUID(),
    topic_id:         fm["slug"] ?? slug,
    brief_id:         `${slug}-brief`,
    markdown_content: markdown,
    word_count:       wordCount,
    file_path:        mdPath,
    iteration_count:  1,
    created_at:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  };

  // Try to load the real content brief from pipeline-data
  // Fall back to a minimal one built from frontmatter
  let brief: ContentBrief;
  const topicsFile = path.join(dataDir, "latest-topics.json");
  let matchedTopic: TopicCard | undefined;

  if (fs.existsSync(topicsFile)) {
    const topics: TopicCard[] = JSON.parse(fs.readFileSync(topicsFile, "utf-8"));
    matchedTopic = topics.find((t) =>
      t.primary_keyword?.toLowerCase().replace(/\s+/g, "-") === slug ||
      t.title?.toLowerCase().includes(slug.replace(/-/g, " ").slice(0, 20))
    );
  }

  if (matchedTopic) {
    console.log(`✅ Matched topic from local store: "${matchedTopic.title}"`);
  }

  // Build brief from frontmatter (works even without a matched topic)
  brief = {
    topic_id:          matchedTopic?.id ?? slug,
    seo_package_id:    `${slug}-seo`,
    yaml_frontmatter: {
      meta_title:          fm["meta_title"]        ?? fm["title"] ?? slug,
      meta_description:    fm["meta_description"]  ?? "",
      primary_keyword:     fm["primary_keyword"]   ?? slug.replace(/-/g, " "),
      secondary_keywords:  (fm["secondary_keywords"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      slug,
    },
    h1:                    fm["title"]             ?? slug,
    h2_outline:            [],
    word_count_target:     { min: 800, max: 1200 },
    feature_to_highlight:  (matchedTopic?.respireLYF_feature ?? "Breathing Fingerprint + MD-RIC daily MEEPs") as any,
    opening_angle:         "",
    ymyl_section_required: markdown.toLowerCase().includes("when to see a doctor"),
    tone_note:             "",
    fda_red_flags:         [],
    created_at:            new Date().toISOString(),
  };

  // Post to Payload
  console.log(`🚀 Posting to Payload CMS at ${process.env.PAYLOAD_URL}…\n`);
  const result = await runPayloadPoster(draft, brief);

  if (result.success && result.data) {
    console.log("\n✅ SUCCESS");
    console.log(`   Payload draft : ${result.data.adminUrl}`);
    console.log(`   Slug          : ${result.data.slug}`);
  } else {
    console.error("\n❌ FAILED:", result.error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
