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
  if (!fs.existsSync(envPath)) {
    console.warn(`⚠️   [DEBUG] .env not found at ${envPath} — relying on shell env`);
    return { path: envPath, found: false, keys: [] };
  }
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  const keys = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) { process.env[key] = val; keys.push(key); }
  }
  return { path: envPath, found: true, keys };
}
const envInfo = loadEnv();

const PAYLOAD_URL         = process.env.PAYLOAD_URL         || "http://localhost:3000";
const PAYLOAD_EMAIL       = process.env.PAYLOAD_EMAIL       || "";
const PAYLOAD_PASSWORD    = process.env.PAYLOAD_PASSWORD    || "";
const NANO_BANANA_API_KEY = process.env.NANO_BANANA_API_KEY || "";
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY   || "";
const NB_BASE_URL         = "https://api.nanobananaapi.ai/api/v1/nanobanana";
const GENERATE_IMAGES     = !!NANO_BANANA_API_KEY && NANO_BANANA_API_KEY !== "your-nano-banana-key";
const EVALUATOR_ENABLED   = !!ANTHROPIC_API_KEY;

console.log("🛠  [DEBUG] --- Environment ---");
console.log(`🛠  [DEBUG] .env file       : ${envInfo.found ? envInfo.path : "(not found)"}`);
console.log(`🛠  [DEBUG] Keys loaded     : ${envInfo.keys.join(", ") || "(none)"}`);
console.log(`🛠  [DEBUG] PAYLOAD_URL     : ${PAYLOAD_URL}`);
console.log(`🛠  [DEBUG] PAYLOAD_EMAIL   : ${PAYLOAD_EMAIL || "(empty!)"}`);
console.log(`🛠  [DEBUG] Password set    : ${PAYLOAD_PASSWORD ? "yes (len=" + PAYLOAD_PASSWORD.length + ")" : "NO"}`);
console.log(`🛠  [DEBUG] NANO_BANANA_KEY : ${GENERATE_IMAGES ? "yes (len=" + NANO_BANANA_API_KEY.length + ") — images WILL generate" : "(not set) — images SKIPPED"}`);
console.log(`🛠  [DEBUG] ANTHROPIC_KEY   : ${EVALUATOR_ENABLED ? "yes (len=" + ANTHROPIC_API_KEY.length + ") — vision evaluator ACTIVE" : "(not set) — evaluator DISABLED (images used as-is)"}`);
console.log(`🛠  [DEBUG] Node version    : ${process.version}`);
console.log(`🛠  [DEBUG] CWD             : ${process.cwd()}\n`);

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

// ─── Strip leading ```yaml / ``` fence wrappers ─────────────────────────────
// Some blog files accidentally wrap their frontmatter in a code fence like:
//   ```yaml
//   ---
//   title: ...
//   ---
//   ```
// Our parser expects `---` as the very first line, so strip those fences first.
function stripLeadingCodeFence(md) {
  // Drop a single leading ```yaml|```yml|``` line
  let out = md.replace(/^\s*```(?:ya?ml)?\s*\r?\n/, "");
  // Drop the matching closing ``` that appears right after the frontmatter's
  // closing `---`. Pattern: "---\n```\n" → "---\n"
  out = out.replace(/(^|\n)---\r?\n```\s*\r?\n/, "$1---\n");
  return out;
}

// ─── Parse YAML frontmatter ─────────────────────────────────────────────────
// Handles:
//   - optional ```yaml fence wrapper (via stripLeadingCodeFence upstream)
//   - nested list values (e.g. `keywords:\n  - foo\n  - bar`) — collected as arrays
//   - quoted strings
function parseFrontmatter(md) {
  const stripped = stripLeadingCodeFence(md);
  const match = stripped.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  let currentListKey = null;
  for (const line of lines) {
    // Array item continuation:  "  - value"
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && currentListKey) {
      const v = listItem[1].trim().replace(/^["']|["']$/g, "");
      (meta[currentListKey] = meta[currentListKey] || []).push(v);
      continue;
    }
    currentListKey = null;
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rawVal = line.slice(eq + 1).trim();
    if (!key) continue;
    if (rawVal === "") {
      // Start of a list / block; remember the key so subsequent "- item" lines attach to it
      currentListKey = key;
      meta[key] = [];
    } else {
      meta[key] = rawVal.replace(/^["']|["']$/g, "");
    }
  }
  // Flatten array keywords back to comma-separated string where the existing
  // code expects a scalar (primary_keyword / secondary_keywords).
  if (Array.isArray(meta.keywords)) {
    if (!meta.primary_keyword)     meta.primary_keyword     = meta.keywords[0] || "";
    if (!meta.secondary_keywords)  meta.secondary_keywords  = meta.keywords.slice(1).join(", ");
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
// Defensively clean up URLs produced by the LLM blog writer.
//   - Strip duplicated absolute prefixes like "https://site.comhttps://site.com/x"
//   - Collapse doubled schemes ("https://https://x" → "https://x")
//   - Trim whitespace & trailing punctuation from autolinks
function normalizeLinkUrl(url) {
  if (typeof url !== "string") return url;
  let u = url.trim();
  // "https://host.comhttps://host.com/path" → keep the inner absolute URL
  const dup = u.match(/^https?:\/\/[^\s/]+(https?:\/\/.+)$/i);
  if (dup) u = dup[1];
  // "https://https://x" → "https://x"
  u = u.replace(/^(https?:\/\/)(https?:\/\/)/i, "$2");
  // Remove stray trailing punctuation the LLM sometimes glues on (",", ".", ")")
  u = u.replace(/[)\].,;]+$/, "");
  return u;
}

function linkNode(children, url) {
  const cleanUrl = normalizeLinkUrl(url);
  return {
    children, direction: null, format: "", indent: 0, type: "link", version: 3, textFormat: 0,
    fields: { url: cleanUrl, linkType: "custom" }, id: genId(),
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

function markdownToLexical(body, images = []) {
  // Build per-placement queues so multiple images at the same placement
  // (e.g. 2× "inline") are consumed in document order.
  const queues = {};
  for (const img of images) (queues[img.placement] = queues[img.placement] || []).push(img);
  // Hero is set as featuredImage on the blog post itself, so we skip it
  // inside the content (avoid duplicate rendering on the detail page).
  const consumeImage = (placement) => {
    if (placement === "hero") return null;
    const q = queues[placement];
    if (!q || q.length === 0) return null;
    return q.shift();
  };

  // Remove multi-line PROMPT blocks; keep IMAGE markers so we can replace them.
  const cleaned = body.replace(/<!--\s*PROMPT:[\s\S]*?-->/g, "");
  const lines = cleaned.split("\n");
  const nodes = [];
  let inlineImageCount = 0;
  // Drop the very first H1 in body so we don't duplicate the page-level <h1>
  // that the blog template already renders from post.title.
  let firstH1Dropped = false;
  let i = 0;
  while (i < lines.length) {
    const trim = lines[i].trimEnd().trim();
    if (!trim) { i++; continue; }

    // IMAGE marker → upload node (or skipped for hero / unavailable images)
    const imgMatch = trim.match(/^<!--\s*IMAGE:\s*(\w+)\s*-->$/);
    if (imgMatch) {
      const placement = imgMatch[1].toLowerCase();
      const img = consumeImage(placement);
      if (img) {
        if (placement === "cta") {
          nodes.push(heroParagraph(img.mediaId));
        } else {
          const layout = inlineImageCount % 2 === 0 ? "left" : "right";
          nodes.push(uploadNode(img.mediaId, layout));
          inlineImageCount++;
        }
      }
      i++; continue;
    }
    if (trim === "---") { i++; continue; }

    const hm = trim.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      // Skip the first H1 — the page template already renders post.title as <h1>.
      if (hm[1].length === 1 && !firstH1Dropped) {
        firstH1Dropped = true;
        i++; continue;
      }
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
  console.log(`🔐  [DEBUG] Login URL       : ${PAYLOAD_URL}/api/users/login`);
  console.log(`🔐  [DEBUG] Login email     : ${PAYLOAD_EMAIL || "(empty!)"}`);
  console.log(`🔐  [DEBUG] Password length : ${PAYLOAD_PASSWORD.length}`);

  const res = await fetch(`${PAYLOAD_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PAYLOAD_EMAIL, password: PAYLOAD_PASSWORD }),
  });

  const rawText = await res.text();
  console.log(`🔐  [DEBUG] Login status    : ${res.status} ${res.statusText}`);
  console.log(`🔐  [DEBUG] Login body      : ${rawText.slice(0, 500)}${rawText.length > 500 ? "…" : ""}`);

  if (!res.ok) throw new Error(`Login failed (${res.status}): ${rawText}`);

  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) { throw new Error(`Login response was not JSON: ${rawText.slice(0, 200)}`); }

  const { token, user } = parsed;
  if (!token) throw new Error(`Login succeeded but no token returned. Body: ${rawText.slice(0, 300)}`);
  console.log(`🔐  [DEBUG] Token received  : ${token.slice(0, 20)}… (len=${token.length})`);
  console.log(`🔐  [DEBUG] User id         : ${user?.id || "(not returned)"}\n`);
  return token;
}

// ─── Image pipeline: extract → generate (NanoBanana) → evaluate (Claude) → upload (Payload Media) ───

function extractImagePrompts(body) {
  const out = [];
  const regex = /<!--\s*IMAGE:\s*(\w+)\s*-->[\s\S]*?<!--\s*PROMPT:\s*([\s\S]*?)\s*-->/g;
  let m;
  while ((m = regex.exec(body)) !== null) {
    out.push({ placement: m[1].trim().toLowerCase(), prompt: m[2].trim() });
  }
  return out;
}

function aspectForPlacement(p) {
  if (p === "hero" || p === "cta") return "16:9";
  return "4:3";
}

// ─── NanoBananaAPI.ai generator (async: submit → poll → fetch URL) ────────
//   1. POST /generate               → taskId
//   2. GET  /record-info?taskId=…   (poll every 3s, max 2 min)
//   3. When successFlag === 1, fetch response.resultImageUrl → Buffer
async function nanoBananaGenerateImage(prompt, aspectRatio, { imageUrls = [] } = {}) {
  // ── 1. Submit task ─────────────────────────────────────────────────
  const useImageToImage = Array.isArray(imageUrls) && imageUrls.length > 0;
  const submitBody = {
    prompt,
    numImages: 1,
    // NanoBanana docs use these exact (typo'd) enum values:
    type: useImageToImage ? "IMAGETOIAMGE" : "TEXTTOIAMGE",
    image_size: aspectRatio,
    // callBackUrl is marked required in docs but since we're polling we pass
    // a placeholder. The API still generates the image.
    callBackUrl: "https://webhook.site/placeholder-polling-only",
  };
  if (useImageToImage) submitBody.imageUrls = imageUrls;

  const submitRes = await fetch(`${NB_BASE_URL}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NANO_BANANA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(submitBody),
  });
  const submitText = await submitRes.text();
  if (!submitRes.ok) {
    throw new Error(`NanoBanana submit ${submitRes.status}: ${submitText.slice(0, 400)}`);
  }
  let submitJson;
  try { submitJson = JSON.parse(submitText); }
  catch { throw new Error(`NanoBanana submit response not JSON: ${submitText.slice(0, 200)}`); }
  if (submitJson.code !== 200) {
    throw new Error(`NanoBanana submit failed: ${submitJson.msg || "unknown"} — ${JSON.stringify(submitJson).slice(0, 300)}`);
  }
  const taskId = submitJson.data?.taskId;
  if (!taskId) {
    throw new Error(`NanoBanana submit returned no taskId: ${submitText.slice(0, 300)}`);
  }

  // ── 2. Poll for result ─────────────────────────────────────────────
  const pollUrl     = `${NB_BASE_URL}/record-info?taskId=${encodeURIComponent(taskId)}`;
  const maxWaitMs   = 120_000;  // 2 minutes
  const intervalMs  = 3_000;
  const startedAt   = Date.now();
  let pollCount     = 0;

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    pollCount++;

    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${NANO_BANANA_API_KEY}` },
    });
    const pollText = await pollRes.text();

    if (!pollRes.ok) {
      // Transient error — keep polling
      console.warn(`   ⚠  Poll ${pollCount} ${pollRes.status}: ${pollText.slice(0, 150)}`);
      continue;
    }
    let pollJson;
    try { pollJson = JSON.parse(pollText); }
    catch {
      console.warn(`   ⚠  Poll ${pollCount} non-JSON response`);
      continue;
    }

    const flag = pollJson.data?.successFlag;
    //  0 = GENERATING, 1 = SUCCESS, 2 = CREATE_TASK_FAILED, 3 = GENERATE_FAILED
    if (flag === 1) {
      const imageUrl = pollJson.data?.response?.resultImageUrl
                    ?? pollJson.data?.response?.originImageUrl;
      if (!imageUrl) {
        throw new Error(`NanoBanana success but no image URL: ${pollText.slice(0, 300)}`);
      }
      // ── 3. Fetch PNG ──────────────────────────────────────────────
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        throw new Error(`Failed to fetch result image (${imgRes.status}) from ${imageUrl}`);
      }
      const arr = await imgRes.arrayBuffer();
      return Buffer.from(arr);
    }
    if (flag === 2 || flag === 3) {
      throw new Error(
        `NanoBanana task failed (flag=${flag}, errorCode=${pollJson.data?.errorCode}): ` +
        `${pollJson.data?.errorMessage || "unknown"}`
      );
    }
    // flag 0 / undefined → still generating, continue loop
  }
  throw new Error(`NanoBanana task ${taskId} timed out after ${maxWaitMs / 1000}s`);
}

// ─── Prompt enhancer (Layer 1: better first-try quality) ──────────────────
// Wraps raw brief with style/composition/brand/negative directives so Gemini
// gets consistent, professional editorial output.
function enhancePrompt(rawPrompt, placement, { extraGuidance = "", appMockup = null } = {}) {
  const aspectGuide = {
    hero:   "Wide horizontal 16:9 composition suitable for a blog hero. Room for headline overlay if needed, but DO NOT render any text in the image itself.",
    inline: "Balanced 4:3 composition suitable for inline blog illustration. Clean subject, clear focus.",
    cta:    "Warm, inviting 16:9 composition suitable for a call-to-action banner. Aspirational, positive mood.",
  }[placement] || "Balanced editorial composition.";

  // When we have an app mockup reference (IMAGETOIAMGE mode for CTAs), tell
  // the model to composite the provided UI into a modern iPhone held naturally
  // in the scene. The reference image's UI must appear on the phone screen
  // EXACTLY — no invented UI, no altered app content.
  const appMockupBlock = appMockup
    ? `

APP MOCKUP INTEGRATION (CRITICAL — PIXEL-PERFECT, NO HALLUCINATION):
The reference image provided IS an actual screenshot of the RespireLYF iOS app. You MUST reproduce this exact UI pixel-perfect on the screen of a modern iPhone (Dynamic Island, thin bezels, iOS 17+ design) held naturally by a person in the scene. The app UI shown is: "${appMockup.description}".

HARD RULES for the phone screen:
- Copy the reference UI one-to-one: every button, icon, tab bar, text label, chart, color, spacing must match the reference EXACTLY.
- DO NOT invent tabs, labels, charts, numbers, or controls that aren't in the reference.
- DO NOT generate fake/placeholder/garbled text that looks like UI copy — if you can't render a real label from the reference crisply and legibly, simplify the crop rather than hallucinate text.
- All on-screen text must be CRISP, LEGIBLE, English, and real words — no squiggles, no blurred glyphs, no AI gibberish.
- The phone must be held at an angle where the screen is flat and readable (no severe perspective that would make text illegible).
- If any element of the reference UI cannot be reproduced faithfully, crop tighter or zoom in — NEVER fabricate UI.`
    : "";

  return `${rawPrompt}

STYLE: Photorealistic editorial photography with the quality of a professional stock photo from a premium health publication. Shot on a full-frame DSLR, natural window light, shallow depth of field, subtle film grain. Calming health-and-wellness aesthetic — warm but clinical. Color palette: soft blues, warm neutrals, gentle greens.

COMPOSITION: ${aspectGuide} Rule of thirds, clean negative space, magazine-quality framing.

BRAND CONTEXT: Respiratory health content for adult asthma and COPD patients. Tone should feel trustworthy, hopeful, and approachable — never dramatic, frightening, or gory. Represent diverse skin tones and age ranges naturally. Subjects should appear calm, capable, and in control of their health.${appMockupBlock}

QUALITY GUARDRAILS (anatomy and text only — do not instruct the model to avoid looking "AI generated"):
- Hands must have exactly five fingers, correct proportions, no merged or extra digits, no bent-wrong joints.
- Eyes must look the same direction, irises natural, no extra teeth/ears, no warped earrings or jewelry.
- Text on any surface (books, phone screens, labels, signs) must either be REAL WORDS rendered crisply, or left as a blank soft surface ready for compositing. If the reference UI cannot be reproduced faithfully, keep the phone screen a clean soft-white rectangle so a real screenshot can be layered on top in post.
- Backgrounds must not melt, warp, or contain nonsensical geometry (impossible furniture joins, floating objects, repeating patterns).

STRICTLY AVOID: Text overlays of any kind (other than the app UI itself when a mockup is provided), watermarks, brand logos, garbled or distorted letters, invented/fake app UI on phone screens (the reference UI MUST appear one-to-one when a mockup is provided — no redesigning), cartoon/anime/illustrated style (unless the original brief explicitly calls for infographic), medical gore, blood, visibly suffering or distressed patients, hospital ICU settings, distorted anatomy, extra fingers or limbs, overlapping or merged faces, floating body parts.${extraGuidance ? "\n\nADDITIONAL GUIDANCE (from previous-attempt feedback — this MUST be fixed): " + extraGuidance : ""}`;
}

// ─── Vision evaluator (Layer 2: quality gate via Claude Haiku vision) ─────
// Uses Claude Haiku 4.5 (vision-capable, fast, ~$0.001 per eval) to score
// each generated image. Returns structured JSON with pass/fail and feedback
// that's fed back into the next prompt if the image is rejected.
const CLAUDE_EVAL_MODEL = "claude-haiku-4-5-20251001";

async function evaluateImage(buffer, originalPrompt, placement, { hadMockup = false, mockupDescription = "" } = {}) {
  const mockupNote = hadMockup
    ? `\n\nIMPORTANT — MOCKUP FAITHFULNESS CHECK:
This image was generated with an IMAGE-TO-IMAGE reference of the real RespireLYF iOS app ("${mockupDescription}"). A phone should be visible and its on-screen UI should match a real, clean, well-designed iOS app — NOT garbled AI text. If the phone screen shows unreadable/gibberish text, invented UI that looks fake, squiggles pretending to be letters, or a generic "AI-photoshoot" phone glow instead of a real-app screenshot, the image FAILS on "mockup_faithful" and "screen_text_legible".`
    : "";

  const evalPrompt = `You are evaluating an image for a respiratory health blog (asthma & COPD for adults). This image will be published on a professional health site so it should look polished and editorial. We accept that modern blog photography is often AI assisted — do NOT penalize images for "looking AI" if they are otherwise clean, relevant, and free of anatomy or text artifacts.

ORIGINAL BRIEF: "${originalPrompt}"
PLACEMENT: ${placement} (hero = lead blog image, inline = mid-article illustration, cta = call-to-action banner)${mockupNote}

Score the image on these criteria. Respond with STRICT JSON ONLY — no markdown code fence, no prose, no explanation. Just the JSON object:

{
  "pass": true or false,
  "scores": {
    "relevance": 1-10,
    "quality": 1-10,
    "brand_fit": 1-10
  },
  "text_artifacts": true or false,
  "anatomy_issues": true or false,
  "phone_visible": true or false,
  "screen_usable": true or false,
  "mockup_faithful": true or false,
  "feedback": "one concise sentence describing the SPECIFIC problem to fix (empty string if pass=true)"
}

SCORING GUIDE:
- relevance: how well the image matches the brief (10 = perfect match)
- quality: professional editorial standard (10 = polished enough for a premium blog)
- brand_fit: calming, trustworthy, not dramatic/gory (10 = perfect tone)
- text_artifacts: true if garbled letters, watermarks, brand logos, fake labels, or squiggle-pretending-to-be-text is visible on any real-world surface (books, signs, clothing). Blank or softly abstract phone screens are NOT text artifacts — they are intentional for later compositing.
- anatomy_issues: true if distorted faces, extra/merged/missing fingers, wrong-joint hands, floating body parts
- phone_visible: true if a phone/smartphone is clearly visible in the image
- screen_usable: true if EITHER (phone_visible=false) OR (the phone screen is a clean blank soft-white area ready for compositing) OR (the on-screen UI is crisp, real, readable English matching the reference mockup). Only false if the screen shows garbled/gibberish text pretending to be UI.
- mockup_faithful: true ONLY IF hadMockup=${hadMockup ? "true" : "false"} AND the on-screen UI either looks like a real professional iOS app OR the screen was intentionally left blank for compositing. If no mockup was expected, default this to true.

PASS RULE: all three scores >= 7 AND text_artifacts=false AND anatomy_issues=false AND screen_usable=true AND mockup_faithful=true.

A blank or softly abstract phone screen is always acceptable and should PASS — the design team composites the real app screenshot in post. Only fail for genuine anatomy or fake-text problems.`;

  const body = {
    model: CLAUDE_EVAL_MODEL,
    max_tokens: 400,
    temperature: 0.2,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: buffer.toString("base64"),
          },
        },
        { type: "text", text: evalPrompt },
      ],
    }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude evaluator ${res.status}: ${text.slice(0, 300)}`);

  let outer;
  try { outer = JSON.parse(text); }
  catch { throw new Error(`Claude evaluator response not JSON: ${text.slice(0, 200)}`); }

  // Claude returns content as an array of blocks; the first text block has our JSON
  const innerText = outer?.content?.find(b => b.type === "text")?.text || "";
  // Strip optional code fence (```json ... ```) if model still wraps it
  const cleaned = innerText
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    // Lenient fallback so pipeline still ships — log and accept
    console.warn(`🔍  [DEBUG] Evaluator returned non-JSON; treating as pass. Raw: ${innerText.slice(0, 200)}`);
    return {
      pass: true,
      scores: { relevance: 7, quality: 7, brand_fit: 7 },
      text_artifacts: false,
      anatomy_issues: false,
      ai_tells: false,
      phone_visible: false,
      screen_text_legible: true,
      mockup_faithful: true,
      feedback: "",
    };
  }

  // Defensive defaults for any missing fields (older model outputs)
  if (typeof parsed.ai_tells !== "boolean") parsed.ai_tells = false;
  if (typeof parsed.phone_visible !== "boolean") parsed.phone_visible = false;
  if (typeof parsed.screen_text_legible !== "boolean") parsed.screen_text_legible = !parsed.phone_visible;
  if (typeof parsed.mockup_faithful !== "boolean") parsed.mockup_faithful = !hadMockup ? true : false;

  // Re-compute pass in case the model returned pass=true but flagged one of the new signals
  const s = parsed.scores || {};
  const scoresOk = (s.relevance || 0) >= 7 && (s.quality || 0) >= 7 && (s.brand_fit || 0) >= 7;
  const cleanSignals =
    !parsed.text_artifacts &&
    !parsed.anatomy_issues &&
    !parsed.ai_tells &&
    parsed.screen_text_legible &&
    parsed.mockup_faithful;
  parsed.pass = scoresOk && cleanSignals;

  return parsed;
}

async function uploadToPayloadMedia(token, buffer, filename, altText) {
  const form = new FormData();
  form.append("_payload", JSON.stringify({ alt: altText || filename }));
  form.append("file", new Blob([buffer], { type: "image/png" }), filename);
  const res = await fetch(`${PAYLOAD_URL}/api/media`, {
    method: "POST",
    headers: { Authorization: `JWT ${token}` },
    body: form,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Media upload failed (${res.status}): ${raw.slice(0, 400)}`);
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`Media response not JSON: ${raw.slice(0, 200)}`); }
  const doc = json.doc || json;
  if (!doc?.id) throw new Error(`Media upload returned no id: ${raw.slice(0, 300)}`);
  return { id: doc.id, filename: doc.filename, url: doc.url };
}

// ─── App-mockup manifest + one-time Payload upload cache ──────────────────
// We use real RespireLYF app screens as reference images for CTA generation
// (NanoBanana IMAGETOIAMGE mode). Each mockup is uploaded to Payload Media
// once; the resulting public URLs are cached on disk so subsequent pipeline
// runs skip the upload step entirely.
const MOCKUP_MANIFEST_PATH = path.join(__dirname, "app-mockups.json");
const MOCKUP_CACHE_PATH    = path.join(__dirname, ".app-mockups-cache.json");

function loadMockupManifest() {
  if (!fs.existsSync(MOCKUP_MANIFEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MOCKUP_MANIFEST_PATH, "utf-8"));
  } catch (e) {
    console.warn(`🖼   [DEBUG] Could not parse ${MOCKUP_MANIFEST_PATH}: ${e.message}`);
    return null;
  }
}

function loadMockupCache() {
  if (!fs.existsSync(MOCKUP_CACHE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(MOCKUP_CACHE_PATH, "utf-8")); }
  catch { return {}; }
}

function saveMockupCache(cache) {
  fs.writeFileSync(MOCKUP_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Upload any missing mockups to Payload Media; return map of id → { url, description }.
async function ensureAppMockupsUploaded(token) {
  const manifest = loadMockupManifest();
  if (!manifest?.mockups) return { default: null, mockups: {} };

  const cache = loadMockupCache();
  const resolved = {};
  let mutated = false;

  for (const [id, spec] of Object.entries(manifest.mockups)) {
    const absPath = path.resolve(__dirname, spec.path);
    const fileExists = fs.existsSync(absPath);

    // Cache hit: already uploaded previously
    if (cache[id]?.url && cache[id]?.fileHash === (fileExists ? fs.statSync(absPath).size : null)) {
      resolved[id] = { ...cache[id], description: spec.description, keywords: spec.keywords || [] };
      continue;
    }

    if (!fileExists) {
      console.warn(`🖼   [DEBUG] Mockup "${id}" file missing at ${absPath} — skipping.`);
      continue;
    }

    console.log(`🖼   [DEBUG] Uploading mockup "${id}" → Payload Media (${path.basename(absPath)})…`);
    try {
      const buf      = fs.readFileSync(absPath);
      const filename = `mockup-${id}-${path.basename(absPath)}`;
      const { id: mediaId, url: relUrl } = await uploadToPayloadMedia(
        token, buf, filename, `RespireLYF app mockup: ${id}`
      );
      // Payload returns a relative URL like /api/media/file/xyz.png — prefix with base
      const absUrl = relUrl?.startsWith("http") ? relUrl : `${PAYLOAD_URL}${relUrl}`;
      cache[id] = { mediaId, url: absUrl, fileHash: fs.statSync(absPath).size, uploadedAt: new Date().toISOString() };
      resolved[id] = { ...cache[id], description: spec.description, keywords: spec.keywords || [] };
      mutated = true;
      console.log(`🖼   [DEBUG]   ✓ ${id} → ${absUrl}`);
    } catch (err) {
      console.warn(`🖼   [DEBUG]   ✗ Upload failed for "${id}": ${err.message}`);
    }
  }

  if (mutated) saveMockupCache(cache);
  return { default: manifest.default, mockups: resolved };
}

// Pick the best-matching mockup for a given topic / prompt.
// Simple keyword scoring — returns { id, url, description } or null.
function pickMockupForTopic(topicText, appMockups) {
  if (!appMockups?.mockups || Object.keys(appMockups.mockups).length === 0) return null;
  const text = (topicText || "").toLowerCase();

  let best = null, bestScore = 0;
  for (const [id, spec] of Object.entries(appMockups.mockups)) {
    const score = (spec.keywords || [])
      .filter(kw => text.includes(kw.toLowerCase()))
      .length;
    if (score > bestScore) { best = { id, ...spec }; bestScore = score; }
  }
  if (best) return best;

  // Fallback to default
  const def = appMockups.default;
  if (def && appMockups.mockups[def]) return { id: def, ...appMockups.mockups[def] };
  return null;
}

async function generateAndUploadImages(
  token,
  prompts,
  outDir,
  { continueOnError = true, maxRetries = 2, evaluatorEnabled = true, appMockups = null, topicContext = "" } = {}
) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const manifest = [];
  const counters = {};

  for (const { placement, prompt: rawPrompt } of prompts) {
    const idx = (counters[placement] = (counters[placement] || 0) + 1) - 1;
    const aspectRatio = aspectForPlacement(placement);
    const baseFilename = `${placement}-${idx}`;

    // Only CTA placements get an app-mockup reference. Hero/inline stay
    // text-to-image so the editorial scene isn't constrained.
    const mockup = (placement === "cta" && appMockups)
      ? pickMockupForTopic(`${topicContext} ${rawPrompt}`, appMockups)
      : null;
    const imageUrls = mockup?.url ? [mockup.url] : [];

    let bestAttempt = null;  // { buf, score, evalResult, attempt }
    let finalBuf    = null;
    let finalEval   = null;
    let extraGuidance = "";

    console.log(`\n🎨  [DEBUG] ── ${baseFilename} (${aspectRatio}) — brief: "${rawPrompt.slice(0, 90)}${rawPrompt.length > 90 ? "…" : ""}"`);
    if (mockup) {
      console.log(`🖼   [DEBUG]   Mode: IMAGETOIAMGE — referencing app mockup "${mockup.id}" (${mockup.url})`);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const enhanced   = enhancePrompt(rawPrompt, placement, { extraGuidance, appMockup: mockup });
      const suffix     = attempt === 0 ? "" : `-retry${attempt}`;
      const attemptPath = path.join(outDir, `${baseFilename}${suffix}.png`);
      const tag        = `${baseFilename}${attempt > 0 ? ` retry ${attempt}` : ""}`;

      console.log(`🎨  [DEBUG]   Attempt ${attempt + 1}/${maxRetries + 1} — generating…`);
      let buf;
      try {
        buf = await nanoBananaGenerateImage(enhanced, aspectRatio, { imageUrls });
        fs.writeFileSync(attemptPath, buf);
        console.log(`🎨  [DEBUG]   Saved → ${attemptPath} (${buf.length} bytes)`);
      } catch (err) {
        console.error(`🎨  [DEBUG]   GENERATE FAILED ${tag}: ${err.message}`);
        if (attempt === maxRetries) break;
        continue;
      }

      if (!evaluatorEnabled) { finalBuf = buf; break; }

      // ── Evaluate ────────────────────────────────────────────────────
      let evalResult;
      try {
        console.log(`🔍  [DEBUG]   Evaluating via ${CLAUDE_EVAL_MODEL}…`);
        evalResult = await evaluateImage(buf, rawPrompt, placement, {
          hadMockup: !!mockup,
          mockupDescription: mockup?.description || "",
        });
      } catch (err) {
        console.warn(`🔍  [DEBUG]   Evaluator error: ${err.message} — accepting image as-is.`);
        finalBuf = buf;
        break;
      }

      const s = evalResult.scores || {};
      const total = (s.relevance || 0) + (s.quality || 0) + (s.brand_fit || 0);
      const flags = [];
      if (evalResult.text_artifacts) flags.push("TEXT");
      if (evalResult.anatomy_issues) flags.push("ANATOMY");
      if (evalResult.phone_visible && evalResult.screen_usable === false) flags.push("SCREEN-GIBBERISH");
      if (mockup && evalResult.mockup_faithful === false) flags.push("MOCKUP-UNFAITHFUL");
      console.log(
        `🔍  [DEBUG]   Eval: pass=${evalResult.pass} total=${total}/30 ` +
        `(relevance=${s.relevance}, quality=${s.quality}, brand=${s.brand_fit})` +
        (flags.length ? ` ⚠${flags.join(",")}` : "")
      );
      if (evalResult.feedback) {
        console.log(`🔍  [DEBUG]   Feedback: ${evalResult.feedback}`);
      }

      // Track best-scoring attempt in case all fail
      if (!bestAttempt || total > bestAttempt.score) {
        bestAttempt = { buf, score: total, evalResult, attempt };
      }

      if (evalResult.pass) {
        console.log(`🎨  [DEBUG]   ✓ PASS — using this image`);
        finalBuf  = buf;
        finalEval = evalResult;
        break;
      }

      if (attempt < maxRetries) {
        const reasonBits = [];
        if (evalResult.feedback) reasonBits.push(evalResult.feedback);
        if (evalResult.phone_visible && evalResult.screen_usable === false) reasonBits.push("Phone screen shows gibberish or fake UI pretending to be a real app. Either render crisp real UI copy matching the mockup reference, or leave the screen as a clean blank soft-white rectangle so a real screenshot can be composited later.");
        if (mockup && evalResult.mockup_faithful === false) reasonBits.push(`The reference RespireLYF app UI was not reproduced faithfully. Either reproduce the phone screen pixel-accurate to the reference ("${mockup.description}") or keep the phone screen blank soft-white for compositing. No invented tabs or labels.`);
        if (evalResult.text_artifacts) reasonBits.push("Remove garbled or invented text from real-world surfaces (books, signs, clothing). Blank phone screens are fine and intentional.");
        if (evalResult.anatomy_issues) reasonBits.push("Fix anatomy: exactly 5 fingers, no merged digits, natural face proportions, eyes aligned.");
        extraGuidance = reasonBits.length
          ? reasonBits.join(" ")
          : "Previous attempt had quality issues; produce a cleaner, more professional editorial image.";
        console.log(`🎨  [DEBUG]   ✗ REJECTED — retrying with feedback…`);
      } else {
        console.log(`🎨  [DEBUG]   Max retries hit — using best attempt (score=${bestAttempt.score}/30 from attempt ${bestAttempt.attempt + 1})`);
        finalBuf  = bestAttempt.buf;
        finalEval = bestAttempt.evalResult;
      }
    }

    if (!finalBuf) {
      console.error(`🎨  [DEBUG]   ✗ No usable image for ${baseFilename} — skipping upload.`);
      if (!continueOnError) throw new Error(`Could not generate image for ${baseFilename}`);
      continue;
    }

    // ── Upload final ─────────────────────────────────────────────────
    const uploadFilename = `${baseFilename}.png`;
    const uploadPath     = path.join(outDir, uploadFilename);
    // Write the chosen buffer as the canonical file (overwrites retry path if needed)
    fs.writeFileSync(uploadPath, finalBuf);
    try {
      const { id, url } = await uploadToPayloadMedia(token, finalBuf, uploadFilename, rawPrompt.slice(0, 120));
      console.log(`🎨  [DEBUG]   Uploaded → mediaId=${id}${url ? " (" + url + ")" : ""}`);
      manifest.push({
        placement,
        mediaId: id,
        file: uploadPath,
        alt:  rawPrompt.slice(0, 120),
        eval: finalEval || null,
      });
    } catch (err) {
      console.error(`🎨  [DEBUG]   UPLOAD FAILED ${baseFilename}: ${err.message}`);
      if (!continueOnError) throw err;
    }
  }

  const manifestPath = path.join(outDir, "images.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n🎨  [DEBUG] Manifest → ${manifestPath}`);
  console.log(`🎨  [DEBUG] Done: ${manifest.length}/${prompts.length} images ready.`);
  return manifest;
}

// Lexical upload-node (used by markdownToLexical to replace IMAGE markers)
function uploadNode(mediaId, layout) {
  return {
    type: "upload", version: 3, format: "", id: genId(),
    fields: { layout, imagePosition: "center" },
    relationTo: "media",
    value: mediaId,
  };
}
function heroParagraph(mediaId) {
  return paragraphNode([uploadNode(mediaId, "top")]);
}

async function findBySlug(token, slug) {
  const url = `${PAYLOAD_URL}/api/blog?where[slug][equals]=${encodeURIComponent(slug)}&depth=0&limit=1`;
  const res = await fetch(url, { headers: { Authorization: `JWT ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    console.log(`🔎  [DEBUG] findBySlug status: ${res.status} — body: ${text.slice(0, 200)}`);
    return null;
  }
  try {
    const json = JSON.parse(text);
    return json.docs?.[0] || null;
  } catch {
    return null;
  }
}

async function createDraft(token, meta, content, opts = {}) {
  const { featuredImageId, featuredImageAlt, readTime } = opts;
  const body = {
    title:         meta.meta_title   || meta.title || "Untitled",
    slug:          meta.slug,
    content,
    excerpt:       meta.meta_description || "",
    // Use the custom `status` select field (not Payload's built-in _status).
    // Default to "draft" for new posts so a human reviews before publishing.
    status: "draft",
    // publishedDate is required by the collection — set to today for new drafts.
    // Human will update this when they actually publish the post.
    publishedDate: new Date().toISOString(),
    seo: {
      metaTitle:         meta.meta_title       || "",
      metaDescription:   meta.meta_description || "",
      primaryKeywords:   meta.primary_keyword  || "",
      secondaryKeywords: meta.secondary_keywords || "",
    },
  };
  if (featuredImageId)  body.featuredImage    = featuredImageId;
  if (featuredImageAlt) body.featuredImageAlt = featuredImageAlt;
  if (typeof readTime === "number" && readTime > 0) body.readTime = readTime;

  // ─── Check for existing doc with same slug (upsert behaviour) ─────────
  console.log(`🔎  [DEBUG] Checking for existing doc with slug="${body.slug}"…`);
  const existing = await findBySlug(token, body.slug);
  const method   = existing ? "PATCH" : "POST";
  // IMPORTANT:
  //   NEW posts  → POST with status="draft" + today's publishedDate.
  //                Human sets the real publish date when they review and publish.
  //   EXISTING   → PATCH but do NOT override status if already published.
  //                Preserve whatever state the human set.
  if (existing) {
    // Don't downgrade a published post back to draft on re-run
    delete body.status;
    delete body.publishedDate;
  }
  // No ?draft=true — this collection uses a plain `status` field, not Payload's
  // built-in versions/drafts system.
  const endpoint = existing
    ? `${PAYLOAD_URL}/api/blog/${existing.id}?depth=0&fallback-locale=null`
    : `${PAYLOAD_URL}/api/blog?depth=0&fallback-locale=null`;

  if (existing) {
    console.log(`🔎  [DEBUG] Found existing id=${existing.id} (title="${existing.title}", status=${existing.status || "?"}) — will UPDATE (status preserved, not overwritten).`);
  } else {
    console.log(`🔎  [DEBUG] No existing doc — will CREATE as DRAFT (for human review).`);
  }

  console.log(`📬  [DEBUG] ${method} endpoint  : ${endpoint}`);
  console.log(`📬  [DEBUG] Body keys       : ${Object.keys(body).join(", ")}`);
  console.log(`📬  [DEBUG] _status in body : ${body._status || "(not sent — preserving existing status)"}`);
  console.log(`📬  [DEBUG] Title           : ${body.title}`);
  console.log(`📬  [DEBUG] Slug            : ${body.slug || "(missing!)"}`);
  console.log(`📬  [DEBUG] Content nodes   : ${content?.root?.children?.length ?? 0}`);
  console.log(`📬  [DEBUG] Payload size    : ${JSON.stringify(body).length} bytes`);

  const res = await fetch(endpoint, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `JWT ${token}` },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  console.log(`\n📬  [DEBUG] ${method} status   : ${res.status} ${res.statusText}`);
  console.log(`📬  [DEBUG] Response headers:`);
  for (const [k, v] of res.headers.entries()) {
    if (["content-type", "content-length", "location", "set-cookie"].includes(k.toLowerCase())) {
      console.log(`    ${k}: ${v}`);
    }
  }
  console.log(`📬  [DEBUG] Response body  : ${rawText.slice(0, 1000)}${rawText.length > 1000 ? "…" : ""}\n`);

  let result;
  try { result = JSON.parse(rawText); }
  catch (e) { throw new Error(`${method} response was not JSON (status ${res.status}): ${rawText.slice(0, 300)}`); }

  if (!res.ok) {
    const errs = result.errors || result.message || result;
    throw new Error(`${method} failed (${res.status}): ${JSON.stringify(errs, null, 2)}`);
  }

  const id = result.doc?.id || result.id || existing?.id;
  console.log(`📬  [DEBUG] Parsed doc.id   : ${result.doc?.id || "(none)"}`);
  console.log(`📬  [DEBUG] Parsed id       : ${result.id || "(none)"}`);
  console.log(`📬  [DEBUG] Final id used   : ${id || "(NONE — this is the bug!)"}`);

  if (!id) {
    throw new Error(
      `${method} returned ${res.status} but no id was found in response. ` +
      `Full body: ${JSON.stringify(result, null, 2)}`
    );
  }

  // ─── Verify by GET ───────────────────────────────────────────────────────
  console.log(`\n🔍  [DEBUG] Verifying draft exists via GET…`);
  const verify = await fetch(`${PAYLOAD_URL}/api/blog/${id}?depth=0`, {
    headers: { Authorization: `JWT ${token}` },
  });
  const verifyText = await verify.text();
  console.log(`🔍  [DEBUG] Verify status   : ${verify.status} ${verify.statusText}`);
  if (verify.ok) {
    try {
      const vDoc = JSON.parse(verifyText);
      console.log(`🔍  [DEBUG] Verified title  : ${vDoc.title}`);
      console.log(`🔍  [DEBUG] Verified slug   : ${vDoc.slug}`);
      console.log(`🔍  [DEBUG] Verified status : ${vDoc._status}`);
    } catch (e) {
      console.log(`🔍  [DEBUG] Verify body not JSON: ${verifyText.slice(0, 200)}`);
    }
  } else {
    console.log(`🔍  [DEBUG] Verify body     : ${verifyText.slice(0, 500)}`);
    throw new Error(
      `Doc was "created" with id=${id} but GET returned ${verify.status}. ` +
      `This means the POST did not actually persist. Check Payload server logs.`
    );
  }

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

  // ─── Pre-flight validation ─────────────────────────────────────────────
  // parseFrontmatter returns {} when it can't find a `---` block. In that
  // case we'd POST with empty slug/title and Payload would 400 with a
  // "Value must be unique" error on slug (because an empty-slug orphan
  // draft already exists). Fail loudly *before* hitting the API.
  console.log(`\n🔎  [DEBUG] Parsed frontmatter keys: ${Object.keys(meta).join(", ") || "(none)"}`);
  console.log(`🔎  [DEBUG] meta.title         : ${meta.title         || "(missing)"}`);
  console.log(`🔎  [DEBUG] meta.meta_title    : ${meta.meta_title    || "(missing)"}`);
  console.log(`🔎  [DEBUG] meta.slug          : ${meta.slug          || "(missing)"}`);
  console.log(`🔎  [DEBUG] meta.meta_description: ${(meta.meta_description || "(missing)").slice(0, 80)}`);

  if (!meta.slug) {
    console.error(
      `\n❌  Frontmatter parse failed — slug is missing.\n` +
      `    File: ${mdPath}\n` +
      `    Hint: your frontmatter must start with a line containing just "---"\n` +
      `          (no \`\`\`yaml code-fence wrapper around it, or the parser strips it automatically).`
    );
    process.exit(1);
  }
  if (meta.slug !== slug) {
    console.warn(
      `\n⚠️   [DEBUG] Folder slug "${slug}" differs from frontmatter slug "${meta.slug}".\n` +
      `    Using frontmatter slug for the Payload record.`
    );
  }

  // Strip ```yaml fence + frontmatter for Lexical conversion
  let body = markdown.replace(/^\s*```(?:ya?ml)?\s*\r?\n/, "");
  body = body.replace(/^---[\s\S]+?---\r?\n(?:```\s*\r?\n)?/, "");

  console.log(`🚀  Posting to ${PAYLOAD_URL}…\n`);

  // Login first — we need the token for both media upload and blog create
  const token = await login();

  // ─── Image pipeline (optional) ──────────────────────────────────────────
  // NanoBanana generates each IMAGE/PROMPT pair, Payload stores each as a Media
  // doc, and we get back mediaIds to wire into the Lexical content.
  const imagePrompts = extractImagePrompts(body);
  let images = [];
  if (imagePrompts.length === 0) {
    console.log(`🎨  [DEBUG] No <!-- IMAGE: … --> markers in body — skipping image pipeline.`);
  } else if (!GENERATE_IMAGES) {
    console.log(`🎨  [DEBUG] Found ${imagePrompts.length} image prompt(s) but NANO_BANANA_API_KEY not set — skipping generation.`);
    console.log(`🎨  [DEBUG] (Set NANO_BANANA_API_KEY in .env and re-run to auto-generate images.)`);
  } else {
    console.log(`🎨  [DEBUG] Found ${imagePrompts.length} image prompt(s). Generating via NanoBananaAPI (Nano Banana)…`);
    if (!EVALUATOR_ENABLED) {
      console.log(`🎨  [DEBUG] (Claude evaluator disabled — ANTHROPIC_API_KEY not set. Images will be used as-is.)`);
    }

    // Upload RespireLYF app-screen mockups to Payload Media once (cached on
    // disk in .app-mockups-cache.json). CTA images will reference these as
    // input for NanoBanana's IMAGETOIAMGE mode so the generated scene shows
    // the REAL app UI rather than an invented one.
    console.log(`🖼   [DEBUG] Ensuring app mockups are uploaded…`);
    const appMockups = await ensureAppMockupsUploaded(token);
    const mockupCount = Object.keys(appMockups.mockups || {}).length;
    console.log(`🖼   [DEBUG] ${mockupCount} mockup(s) available for CTA reference.`);

    // Topic context helps pickMockupForTopic pick the right screen
    // (e.g. cough-related blog → cough screen).
    const topicContext = [
      meta.title,
      meta.meta_title,
      meta.primary_keyword,
      meta.secondary_keywords,
    ].filter(Boolean).join(" ");

    const outDir = path.join(blogsDir, slug, "generated-images");
    images = await generateAndUploadImages(token, imagePrompts, outDir, {
      evaluatorEnabled: EVALUATOR_ENABLED,
      appMockups,
      topicContext,
    });
    console.log(`🎨  [DEBUG] Uploaded ${images.length}/${imagePrompts.length} to Payload Media.\n`);
  }

  // Hero image → set as featuredImage on the blog post (not in content body).
  // Everything else (inline, cta) gets wired into content via markdownToLexical.
  const heroImage = images.find(img => img.placement === "hero");
  const content = markdownToLexical(body, images);

  // Editorial read time at ~225 wpm (minimum 1 min). Shown in the post meta line.
  const readTime = Math.max(1, Math.ceil(words / 225));

  const { id, adminUrl } = await createDraft(token, meta, content, {
    featuredImageId:  heroImage?.mediaId,
    featuredImageAlt: heroImage?.alt,
    readTime,
  });

  console.log("✅  SUCCESS");
  console.log(`    Payload draft : ${adminUrl}`);
  console.log(`    Slug          : ${slug}`);
  console.log(`    Images        : ${images.length} uploaded${heroImage ? " (hero set as featuredImage)" : ""}\n`);
}

main().catch(err => {
  console.error("\n❌  Error:", err.message);
  process.exit(1);
});
