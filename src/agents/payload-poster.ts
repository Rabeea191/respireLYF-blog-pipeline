/**
 * Stage 11 — Payload CMS Poster
 *
 * Takes the approved .md blog file and posts it to Payload CMS as a draft.
 * Based on upload-blog.ts — adapted for pipeline use as an importable module.
 *
 * Converts Markdown → Payload Lexical JSON, authenticates, creates the blog draft.
 * The human review dashboard will show the draft before publishing.
 */

import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import type { BlogDraft, ContentBrief, AgentResult } from "../types";

// ─── Payload config (read lazily so dotenv has time to load) ──────────────
function getPayloadConfig() {
  return {
    url:      process.env.PAYLOAD_URL      ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    email:    process.env.PAYLOAD_EMAIL    ?? "admin@respirelyf.com",
    password: process.env.PAYLOAD_PASSWORD ?? "",
  };
}

// ─── Types ─────────────────────────────────────────────────────────────────
interface ImageInput {
  placement: string;
  mediaId: string;
  layout?: "top" | "left" | "right";
}

// ─── Node builders (Payload Lexical format) ────────────────────────────────

function genId(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function textNode(text: string, format = 0) {
  return { detail: 0, format, mode: "normal", style: "", text, type: "text", version: 1 };
}

function paragraphNode(children: object[], textFormat = 0) {
  return { children, direction: null, format: "", indent: 0, type: "paragraph", version: 1, textFormat, textStyle: "" };
}

function headingNode(children: object[], tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return { children, direction: null, format: "", indent: 0, type: "heading", version: 1, textFormat: 1, tag };
}

function horizontalRuleNode() {
  return { type: "horizontalrule", version: 1 };
}

function quoteNode(children: object[]) {
  return { children, direction: null, format: "", indent: 0, type: "quote", version: 1 };
}

function listItemNode(children: object[], value: number) {
  return { children, direction: null, format: "", indent: 0, type: "listitem", version: 1, value };
}

function listNode(items: object[][], listType: "bullet" | "number") {
  return {
    children: items.map((children, i) => listItemNode(children, i + 1)),
    direction: null, format: "", indent: 0, type: "list", version: 1,
    listType, start: 1, tag: listType === "bullet" ? "ul" : "ol",
  };
}

function linkNode(children: object[], url: string) {
  return {
    children, direction: null, format: "", indent: 0, type: "link", version: 3, textFormat: 0,
    fields: { url, linkType: "custom" }, id: genId(),
  };
}

function uploadNodeShape(mediaId: string, layout: "top" | "left" | "right") {
  return {
    type: "upload", version: 3, format: "", id: genId(),
    fields: { layout, imagePosition: "center" }, relationTo: "media", value: mediaId,
  };
}

function heroParagraphNode(mediaId: string) {
  return paragraphNode([uploadNodeShape(mediaId, "top")]);
}

function inlineUploadNode(mediaId: string, layout: "left" | "right") {
  return uploadNodeShape(mediaId, layout);
}

// ─── Inline text parser ────────────────────────────────────────────────────
function parseInline(text: string): object[] {
  const nodes: object[] = [];
  const regex = /(\[([^\]]+)\]\(([^)]+)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|([^*\[]+))/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match[2] !== undefined && match[3] !== undefined) {
      nodes.push(linkNode([textNode(match[2])], match[3]));
    } else if (match[4] !== undefined) {
      nodes.push(textNode(match[4], 3));
    } else if (match[5] !== undefined) {
      nodes.push(textNode(match[5], 1));
    } else if (match[6] !== undefined) {
      nodes.push(textNode(match[6], 2));
    } else if (match[7] !== undefined) {
      nodes.push(textNode(match[7], 0));
    }
  }

  return nodes.length ? nodes : [textNode(text, 0)];
}

// ─── Frontmatter parser ────────────────────────────────────────────────────
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, "");
    if (key) meta[key] = value;
  }

  return { meta, body: match[2] };
}

// ─── Markdown → Payload Lexical ────────────────────────────────────────────
function markdownToLexical(body: string, images: ImageInput[]): object {
  const queues: Record<string, string[]> = {};
  const overrideLayouts: Record<string, Array<"top" | "left" | "right" | undefined>> = {};
  for (const img of images) {
    (queues[img.placement] ??= []).push(img.mediaId);
    (overrideLayouts[img.placement] ??= []).push(img.layout);
  }
  const pointers: Record<string, number> = {};

  function consumeImage(placement: string) {
    const queue = queues[placement];
    if (!queue || queue.length === 0) return null;
    const ptr = pointers[placement] ?? 0;
    if (ptr >= queue.length) return null;
    const mediaId = queue[ptr];
    const layout = overrideLayouts[placement]?.[ptr];
    pointers[placement] = ptr + 1;
    return { mediaId, layout };
  }

  const cleaned = body.replace(/<!--\s*PROMPT:[\s\S]*?-->/g, "");
  const lines = cleaned.split("\n");
  const nodes: object[] = [];
  let inlineImageCount = 0;
  let i = 0;

  while (i < lines.length) {
    const raw  = lines[i];
    const line = raw.trimEnd();
    const trim = line.trim();

    if (!trim) { i++; continue; }

    // IMAGE comment
    const imageMatch = trim.match(/^<!--\s*IMAGE:\s*(\w+)\s*-->$/);
    if (imageMatch) {
      const placement = imageMatch[1];
      const img = consumeImage(placement);
      if (img) {
        if (placement === "hero" || placement === "cta") {
          nodes.push(heroParagraphNode(img.mediaId));
        } else {
          const layout = img.layout ?? (inlineImageCount % 2 === 0 ? "left" : "right");
          nodes.push(inlineUploadNode(img.mediaId, layout as "left" | "right"));
          inlineImageCount++;
        }
      }
      i++; continue;
    }

    if (trim === "---") { nodes.push(horizontalRuleNode()); i++; continue; }

    const headingMatch = trim.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const tag = `h${headingMatch[1].length}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      nodes.push(headingNode(parseInline(headingMatch[2]), tag));
      i++; continue;
    }

    if (trim.startsWith("> ")) {
      const quoteText: string[] = [];
      while (i < lines.length && lines[i].trimEnd().startsWith("> ")) {
        quoteText.push(lines[i].trimEnd().replace(/^>\s?/, ""));
        i++;
      }
      nodes.push(quoteNode(quoteText.flatMap((t) => parseInline(t))));
      continue;
    }

    if (trim.match(/^[-*]\s+/)) {
      const items: object[][] = [];
      while (i < lines.length && lines[i].trimEnd().match(/^[-*]\s+/)) {
        items.push(parseInline(lines[i].trimEnd().replace(/^[-*]\s+/, "")));
        i++;
      }
      nodes.push(listNode(items, "bullet"));
      continue;
    }

    if (trim.match(/^\d+\.\s+/)) {
      const items: object[][] = [];
      while (i < lines.length && lines[i].trimEnd().match(/^\d+\.\s+/)) {
        items.push(parseInline(lines[i].trimEnd().replace(/^\d+\.\s+/, "")));
        i++;
      }
      nodes.push(listNode(items, "number"));
      continue;
    }

    const children = parseInline(trim);
    const textFormats = (children as any[]).filter((c) => c.type === "text").map((c) => c.format as number);
    const allSame = textFormats.length > 0 && textFormats.every((f) => f === textFormats[0]);
    nodes.push(paragraphNode(children, allSame ? textFormats[0] : 0));
    i++;
  }

  return { root: { children: nodes, direction: null, format: "", indent: 0, type: "root", version: 1 } };
}

// ─── Payload auth + post ───────────────────────────────────────────────────
async function loginToPayload(): Promise<string> {
  const { url, email, password } = getPayloadConfig();
  const res = await fetch(`${url}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(`Payload login failed: ${await res.text()}`);
  }

  const { token } = await res.json() as { token: string };
  return token;
}

async function createDraft(
  token: string,
  meta: Record<string, string>,
  content: object,
  brief: ContentBrief
): Promise<{ id: string; adminUrl: string }> {
  const slug = meta["slug"] ?? brief.yaml_frontmatter.slug;

  const payload = {
    title:         meta["meta_title"]         ?? brief.yaml_frontmatter.meta_title,
    slug,
    content,
    _status:       "draft",
    publishedDate: new Date().toISOString(),
    excerpt:       meta["meta_description"]   ?? brief.yaml_frontmatter.meta_description,
    seo: {
      metaTitle:       meta["meta_title"]       ?? brief.yaml_frontmatter.meta_title,
      metaDescription: meta["meta_description"] ?? brief.yaml_frontmatter.meta_description,
      primaryKeywords: brief.yaml_frontmatter.primary_keyword,
      secondaryKeywords: brief.yaml_frontmatter.secondary_keywords.join(", "),
    },
  };

  const { url: PAYLOAD_URL } = getPayloadConfig();
  const res = await fetch(`${PAYLOAD_URL}/api/blog?depth=0&fallback-locale=null`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `JWT ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await res.json() as any;

  if (!res.ok) {
    throw new Error(`Payload create failed: ${JSON.stringify(result.errors ?? result)}`);
  }

  return {
    id: result.doc?.id ?? result.id,
    adminUrl: `${getPayloadConfig().url}/admin/collections/blog/${result.doc?.id}`,
  };
}

// ─── Main export ───────────────────────────────────────────────────────────
export async function runPayloadPoster(
  draft: BlogDraft,
  brief: ContentBrief,
  images: ImageInput[] = []
): Promise<AgentResult<{ payloadId: string; adminUrl: string; slug: string }>> {
  const start = Date.now();

  return logger.timed("payload-poster", `Posting "${brief.h1}" to Payload CMS`, async () => {
    const { password: PAYLOAD_PASSWORD } = getPayloadConfig();
    if (!PAYLOAD_PASSWORD) {
      return {
        success: false,
        error: "PAYLOAD_PASSWORD env var not set — cannot post to CMS",
        iteration: 1,
        duration_ms: Date.now() - start,
      };
    }

    // Parse markdown
    const { meta, body } = parseFrontmatter(draft.markdown_content);
    const content = markdownToLexical(body, images);

    // Authenticate
    let token: string;
    try {
      token = await loginToPayload();
    } catch (err: any) {
      return {
        success: false,
        error: `Payload auth failed: ${err.message}`,
        iteration: 1,
        duration_ms: Date.now() - start,
      };
    }

    // Create draft
    try {
      const { id, adminUrl } = await createDraft(token, meta, content, brief);

      logger.info("payload-poster", `✅ Draft created: ${adminUrl}`);

      return {
        success: true,
        data: {
          payloadId: id,
          adminUrl,
          slug: brief.yaml_frontmatter.slug,
        },
        iteration: 1,
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message,
        iteration: 1,
        duration_ms: Date.now() - start,
      };
    }
  });
}
