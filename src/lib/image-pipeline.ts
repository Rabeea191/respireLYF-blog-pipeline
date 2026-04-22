/**
 * Image pipeline — blog body → NanoBanana images → Payload Media uploads
 *
 * Port of the core image-generation logic from post-blog.js into a clean
 * TypeScript module so Tier 2 can generate and attach images inline when
 * it drafts a blog to Payload, rather than relying on a separate Node
 * script. Keeps the essentials only:
 *   1. Extract <!-- IMAGE: placement --> / <!-- PROMPT: … --> pairs
 *   2. Wrap each brief with style/quality guardrails (enhancePrompt)
 *   3. Submit to NanoBanana, poll for completion, fetch the PNG
 *   4. Upload the PNG to Payload Media, return { placement, mediaId, alt }
 *
 * This module intentionally skips the Claude vision evaluator + app-mockup
 * compositing that post-blog.js does — those can be layered back in later
 * without changing the integration surface.
 */

import { config } from "./config";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────
export interface ImagePrompt {
  placement: string;
  prompt: string;
}

export interface GeneratedImage {
  placement: string;
  mediaId: string;
  alt: string;
  /** Layout hint for Lexical upload node. Unset = auto-alternate. */
  layout?: "top" | "left" | "right";
}

// ─── Extract IMAGE/PROMPT markers from body ──────────────────────────────
export function extractImagePrompts(body: string): ImagePrompt[] {
  const out: ImagePrompt[] = [];
  const regex = /<!--\s*IMAGE:\s*(\w+)\s*-->[\s\S]*?<!--\s*PROMPT:\s*([\s\S]*?)\s*-->/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    out.push({ placement: m[1].trim().toLowerCase(), prompt: m[2].trim() });
  }
  return out;
}

function aspectForPlacement(p: string): string {
  if (p === "hero" || p === "cta") return "16:9";
  return "4:3";
}

// ─── Prompt wrapper (style + quality guardrails) ─────────────────────────
function enhancePrompt(rawPrompt: string, placement: string): string {
  const aspectGuide: Record<string, string> = {
    hero:   "Wide horizontal 16:9 composition suitable for a blog hero. Room for headline overlay if needed, but DO NOT render any text in the image itself.",
    inline: "Balanced 4:3 composition suitable for inline blog illustration. Clean subject, clear focus.",
    cta:    "Warm, inviting 16:9 composition suitable for a call-to-action banner. Aspirational, positive mood.",
  };
  const guide = aspectGuide[placement] ?? "Balanced editorial composition.";

  return `${rawPrompt}

STYLE: Photorealistic editorial photography with the quality of a professional stock photo from a premium health publication. Shot on a full-frame DSLR, natural window light, shallow depth of field, subtle film grain. Calming health-and-wellness aesthetic — warm but clinical. Color palette: soft blues, warm neutrals, gentle greens.

COMPOSITION: ${guide} Rule of thirds, clean negative space, magazine-quality framing.

BRAND CONTEXT: Respiratory health content for adult asthma and COPD patients. Tone should feel trustworthy, hopeful, and approachable — never dramatic, frightening, or gory. Represent diverse skin tones and age ranges naturally. Subjects should appear calm, capable, and in control of their health.

QUALITY GUARDRAILS:
- Hands must have exactly five fingers, correct proportions, no merged or extra digits, no bent-wrong joints.
- Eyes must look the same direction, irises natural, no extra teeth/ears, no warped jewelry.
- Any text on real-world surfaces (books, signs, labels, phone screens) must either be real words rendered crisply, or kept as a clean blank soft-white surface for compositing later.
- Backgrounds must not melt, warp, or contain nonsensical geometry.

STRICTLY AVOID: Text overlays, watermarks, brand logos, garbled letters, cartoon/anime/illustrated style, medical gore, blood, visibly suffering patients, hospital ICU settings, distorted anatomy, extra fingers or limbs, floating body parts.`;
}

// ─── NanoBanana generator (submit → poll → fetch) ────────────────────────
async function nanoBananaGenerate(
  prompt: string,
  aspectRatio: string,
): Promise<Buffer> {
  const apiKey  = config.nanoBanana.apiKey;
  const baseUrl = config.nanoBanana.baseUrl;
  if (!apiKey) throw new Error("NANO_BANANA_API_KEY not configured");

  const submitBody = {
    prompt,
    numImages: 1,
    type: "TEXTTOIAMGE" as const,
    image_size: aspectRatio,
    // Polling mode — callback URL is a placeholder the API requires.
    callBackUrl: "https://webhook.site/placeholder-polling-only",
  };

  const submitRes = await fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(submitBody),
  });
  const submitText = await submitRes.text();
  if (!submitRes.ok) {
    throw new Error(`NanoBanana submit ${submitRes.status}: ${submitText.slice(0, 300)}`);
  }
  let submitJson: any;
  try { submitJson = JSON.parse(submitText); }
  catch { throw new Error(`NanoBanana submit non-JSON: ${submitText.slice(0, 200)}`); }
  if (submitJson.code !== 200) {
    throw new Error(`NanoBanana submit failed: ${submitJson.msg || "unknown"}`);
  }
  const taskId = submitJson.data?.taskId;
  if (!taskId) throw new Error(`NanoBanana returned no taskId`);

  // Poll for up to 2 minutes
  const pollUrl    = `${baseUrl}/record-info?taskId=${encodeURIComponent(taskId)}`;
  const maxWaitMs  = 120_000;
  const intervalMs = 3_000;
  const startedAt  = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const pollText = await pollRes.text();
    if (!pollRes.ok) continue;
    let pollJson: any;
    try { pollJson = JSON.parse(pollText); } catch { continue; }

    const flag = pollJson.data?.successFlag;
    if (flag === 1) {
      const imageUrl =
        pollJson.data?.response?.resultImageUrl ??
        pollJson.data?.response?.originImageUrl;
      if (!imageUrl) throw new Error(`NanoBanana success but no image URL`);
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Image fetch ${imgRes.status}`);
      return Buffer.from(await imgRes.arrayBuffer());
    }
    if (flag === 2 || flag === 3) {
      throw new Error(
        `NanoBanana task failed (flag=${flag}): ${pollJson.data?.errorMessage || "unknown"}`,
      );
    }
    // flag 0 / undefined → still generating
  }
  throw new Error(`NanoBanana task ${taskId} timed out after 120s`);
}

// ─── Payload Media upload ────────────────────────────────────────────────
async function uploadToPayloadMedia(
  token: string,
  buffer: Buffer,
  filename: string,
  altText: string,
): Promise<{ id: string; url?: string }> {
  const form = new FormData();
  form.append("_payload", JSON.stringify({ alt: altText || filename }));
  // Pass the Buffer directly — Node Buffer extends Uint8Array, so Blob can
  // wrap it without an extra copy. Avoids a 2x memory spike per image upload.
  form.append(
    "file",
    new Blob([buffer], { type: "image/png" }),
    filename,
  );

  const res = await fetch(`${config.payload.url}/api/media`, {
    method: "POST",
    headers: { Authorization: `JWT ${token}` },
    body: form as any,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Media upload ${res.status}: ${raw.slice(0, 300)}`);
  let json: any;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Media upload non-JSON response`); }
  const doc = json.doc || json;
  if (!doc?.id) throw new Error(`Media upload returned no id`);
  return { id: doc.id, url: doc.url };
}

// ─── End-to-end: body + token → GeneratedImage[] ─────────────────────────
/**
 * Extracts image prompts from the blog body, generates each via NanoBanana,
 * uploads to Payload Media, and returns a list mappable onto Lexical nodes.
 *
 * Returns an empty list (no-op) when:
 *   - NANO_BANANA_API_KEY is not configured
 *   - The body has no <!-- IMAGE: --> markers
 *   - Every image fails to generate/upload (each failure is logged, not thrown)
 */
export async function runImagePipeline(
  token: string,
  body: string,
): Promise<GeneratedImage[]> {
  if (!config.nanoBanana.apiKey) {
    logger.info("image_pipeline", "NANO_BANANA_API_KEY not set — skipping image generation");
    return [];
  }

  const prompts = extractImagePrompts(body);
  if (prompts.length === 0) {
    logger.info("image_pipeline", "No IMAGE markers in blog body — nothing to generate");
    return [];
  }

  logger.info("image_pipeline", `Generating ${prompts.length} image(s) via NanoBanana`);

  const results: GeneratedImage[] = [];
  const counters: Record<string, number> = {};

  for (const { placement, prompt } of prompts) {
    const idx = (counters[placement] = (counters[placement] || 0) + 1) - 1;
    const aspect = aspectForPlacement(placement);
    const filename = `${placement}-${idx}.png`;
    const enhanced = enhancePrompt(prompt, placement);

    try {
      logger.info(
        "image_pipeline",
        `  ▸ ${filename} (${aspect}) — "${prompt.slice(0, 70)}${prompt.length > 70 ? "…" : ""}"`,
      );
      // Wrap buffer lifetime in a block so it's eligible for GC ASAP after upload
      const { id, url } = await (async () => {
        const buf = await nanoBananaGenerate(enhanced, aspect);
        const res = await uploadToPayloadMedia(
          token,
          buf,
          filename,
          prompt.slice(0, 120),
        );
        // Buffer goes out of scope here — eligible for GC before next iteration
        return res;
      })();
      logger.info("image_pipeline", `  ✓ uploaded → mediaId=${id}${url ? ` (${url})` : ""}`);
      results.push({
        placement,
        mediaId: id,
        alt: prompt.slice(0, 120),
      });
      // Hint to V8 that we're okay with collecting now — runs only if
      // `--expose-gc` is passed (set via NODE_OPTIONS on Vercel).
      if (typeof (globalThis as any).gc === "function") {
        (globalThis as any).gc();
      }
    } catch (err: any) {
      logger.warn(
        "image_pipeline",
        `  ✗ Failed ${filename}: ${err.message} — blog will post without this image`,
      );
    }
  }

  logger.info(
    "image_pipeline",
    `Done: ${results.length}/${prompts.length} images uploaded to Payload`,
  );
  return results;
}
