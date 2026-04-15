# RespireLYF — Multi-Agent Blog Pipeline
## Tiered Implementation Plan

**Version:** 1.0  
**Date:** April 2026  
**Owner:** Rabeea Hamza  

---

## Pipeline Architecture Summary

```
TIER 1                    TIER 2                     TIER 3
─────────────────         ────────────────────        ─────────────────────
Trend Scraper Agent  →    SEO Research Agent    →     Asset Generator Agent
Topic Generator      →    Content Brief Agent   →     Blog Writer Agent
Topic Evaluator      →                               Blog Evaluator Agent
Human Approval Loop  ↑────────────────────────────────────────────────────

TIER 4                    TIER 5
──────────────────────    ────────────────────────────────────────────────
HTML Formatter Agent  →   Human Review Dashboard  →  Publish to Payload CMS
Payload CMS API       →   Real-time Feedback Loop →  Live
```

Every tier has its own mini evaluator gate.
Nothing moves forward below threshold.

---

## Tier 0 — Foundation & Infrastructure
**Timeline: Week 1**
**Status: Prerequisites only — no agents built yet**

### What Gets Built
- Project repo structure (monorepo: `/agents`, `/evaluators`, `/api`, `/dashboard`, `/shared`)
- Shared types and data contracts (TypeScript interfaces or Python dataclasses for all agent I/O)
- Database schema in Supabase — pipeline runs, topic cards, blog drafts, evaluator scores, human feedback, approval states
- Environment config system — one `.env` file, all API keys injected per agent
- Logging + observability layer — every agent logs input, output, score, iteration count, and timestamp
- Cron trigger scaffold — Monday 6AM trigger ready to wire

### What You Need to Provide (Tier 0)
| Item | Why It's Needed |
|------|----------------|
| Tech stack decision: **Python** or **TypeScript/Node.js** | Determines agent framework (LangGraph vs Claude Agent SDK vs custom) |
| Deployment environment | Where agents run — AWS Lambda, a VPS, Vercel Edge, or local server |
| Supabase project credentials (URL + anon key + service key) | Database for pipeline state — can create a new project if needed |
| Repo access or new repo creation | All code lives here |

---

## Tier 1 — Trend Intelligence + Topic Pipeline
**Timeline: Weeks 2–3**
**Depends on: Tier 0 complete + Tier 1 API keys provided**

### Agents Built in This Tier

#### 1.1 — Trend Scraper Agent
Runs every Monday 6AM. Pulls trending signals from:
- Google Trends (keyword category: Health → Respiratory)
- Reddit API — r/Asthma, r/COPD top posts last 7 days
- CDC/EPA/NHLBI RSS news feeds
- Google Search autocomplete for 12 seed queries

**Output:** 15–20 raw trend signals as JSON — each with source, trend direction, patient intent flag, and seasonal context tag.

**Mini Evaluator — Trend Gate:**
Scores each signal: patient intent match (1–5) + brand relevance (1–5) + seasonality fit (1–5). Drops signals below 9/15. Passes top 12–15 downstream.

#### 1.2 — Topic Generator Agent
Takes filtered trend signals + blog2.md brand rules + published blog archive (duplicate check).
Generates exactly 5 topic candidates per week.

**Output per topic:**
```json
{
  "title": "Why Cold Air Triggers Asthma",
  "primary_keyword": "cold air asthma trigger",
  "rationale": "Google Trends +40% this week entering allergy season",
  "respireLYF_feature": "Weather & Environment HD",
  "intent_strength": "high",
  "topic_type": "trigger_pattern",
  "ymyl_flag": true
}
```

**Mini Evaluator — Topic Format Gate:**
Hard checks: title under 60 chars, feature mapping present, no duplicate slug, keyword is patient-language (not internal brand language). Regenerates any failing topic automatically.

#### 1.3 — Topic Evaluator Agent (separate from Generator)
Scores all 5 topics on 5 rubric dimensions (10 pts each, 50 max):
1. SEO potential
2. Brand fit
3. Reader urgency (right now)
4. Content differentiation (gap vs. top results)
5. FDA-safe angle achievable

Topics scoring below 30/50 are flagged "revise before human review" and sent back to Generator with specific feedback. Topics 30–39 go to human with a caution note. Topics 40+ go as clean approvals.

#### 1.4 — Human Approval Interface (Tier 1 version: simple)
At this stage: a clean email or Slack message per topic with score card + approve/reject/notes buttons (via a simple webhook URL or Notion database update). Full dashboard comes in Tier 4.

**Human feedback loop:**
- Approved → locked, moves to Tier 2
- Approved with notes → Topic Refiner runs one iteration, returns updated card for final confirm
- Rejected + reason → Generator runs replacement, re-evaluates, re-submits

**Threshold rule:** Minimum 3 of 5 approved per week before Tier 2 begins.

### What You Need to Provide (Tier 1)
| Item | Why It's Needed |
|------|----------------|
| **SerpAPI key** (or DataForSEO Search key) | Google Trends + autocomplete scraping |
| **Reddit API credentials** (client_id + client_secret + user_agent) | r/Asthma, r/COPD trend scraping |
| **Published blog list** (slugs or URLs of existing articles) | Duplicate detection in Topic Generator |
| **Slack webhook URL OR preferred notification method** | Where the human approval card gets sent |
| Decision: approve via **Slack buttons**, **email links**, or **Notion DB** | Determines approval interface build |

---

## Tier 2 — SEO + Content Brief + Blog Writing
**Timeline: Weeks 4–5**
**Depends on: At least 3 approved topics from Tier 1**

### Agents Built in This Tier

#### 2.1 — SEO Research Agent
For each approved topic:
- Pulls exact keyword search volume + difficulty score
- Identifies top 3 competing URLs for the primary keyword
- Runs gap analysis: what are the top results missing that we can own?
- Selects 4–5 secondary keywords (patient-language, semantically related)
- Finds 1–3 existing RespireLYF blog pages for internal linking
- Selects 2 outbound links from approved sources (CDC, NHLBI, GINA, GOLD, NIH)
- Sets YMYL flag + "When to See a Doctor" requirement

**Mini Evaluator — SEO Package Gate:**
Hard checks: 3+ secondary keywords, no prohibited sources (Healthline/WebMD/Verywell), 1–3 internal links, outbound links have valid URLs that resolve, H2 suggestions don't duplicate competitor top headings verbatim. Blocks pipeline if any field missing.

#### 2.2 — Content Brief Agent
Assembles everything into a single structured brief:
- YAML frontmatter (meta title 55–60 chars, meta description 140–155 chars, slug, keywords)
- H1 + H2 outline with keyword placement notes and missing-from-competitors angle
- Word count target: 800–1,200 (firm)
- Feature to highlight (one only, from approved topic card)
- Opening paragraph angle — exact frustration to name
- YMYL/doctor section requirement flag
- Image placement notes (hero, inline, CTA)
- FDA red-flag phrases pre-listed for the writer to avoid
- Tone note specific to this article

#### 2.3 — Blog Writer Agent
Writes the full article strictly against blog2.md and the content brief.

**Hard-coded rules in system prompt:**
- Word count verified before output — rewrite if outside 800–1,200
- FDA language substitution table applied
- Banned words list checked (journey, empower, transform, game-changer, revolutionary, unlock)
- Product intro at exactly 70% mark, one feature only
- "When to See a Doctor" section included if YMYL flag set
- CTA heading always: "Track What's Actually Affecting Your Breathing"
- Further Reading section with 1–2 approved outbound links
- Image prompt HTML comments at hero / inline / CTA positions

**Output:** Complete `.md` file → saved to `blogs/[slug]/[slug].md`

#### 2.4 — Blog Evaluator Agent
Fully separate agent from the writer. Scores the draft.

**Hard fails (block pipeline immediately, return to writer):**
- Word count outside 800–1,200
- Primary keyword missing from H1, first paragraph, or 2+ H2s
- Any banned word present
- Any FDA violation (causes / triggers absolutely / proves / diagnoses / prevents)
- Product intro not at ~70% mark, or mentions more than one feature
- YMYL section missing when flagged
- Further Reading missing or uses prohibited sources
- Any image prompt missing or incorrectly formatted

**Soft scores (returned as feedback, writer improves):**
- Opening hooks with frustration, not definition/stat (1–10)
- Product intro reads naturally, not as an ad (1–10)
- Tone: empathetic and specific, not vague or alarmist (1–10)

**Loop:** Hard fail → specific fix back to writer → re-evaluate. Max 3 iterations. If still failing after 3, escalate to human with a red flag + specific issues listed.

### What You Need to Provide (Tier 2)
| Item | Why It's Needed |
|------|----------------|
| **DataForSEO API key** OR **Ahrefs API key** | Keyword volume + difficulty + competitor analysis |
| **RespireLYF blog sitemap or URL list** | Internal linking — SEO agent needs to know what pages exist |
| **Claude API key** (if not using Anthropic platform) | Blog Writer Agent + Blog Evaluator Agent LLM calls |

---

## Tier 3 — Asset Generation + HTML + Payload CMS
**Timeline: Week 6**
**Depends on: At least 1 approved blog from Tier 2**

### Agents Built in This Tier

#### 3.1 — Asset Generator Agent
For each approved blog brief:
- Reads the topic, tone note, and image placement notes from the brief
- Generates three visually distinct image prompts per blog:
  - Hero (16:9) — cinematic, emotional, sets article tone
  - Inline (16:9) — illustrates a concept or lifestyle moment
  - CTA (1:1) — hopeful, app-adjacent
- Produces both `nano_banana_2_prompt` and `nano_banana_pro_prompt` for each image (content team chooses which model per image)
- Fires prompts to image API if connected; stores returned image URLs

**Mini Evaluator — Image Gate:**
Hard checks: all 3 placements present, all have both prompt variants, no two images share same subject + palette + composition (visual differentiation rule), no portrait orientation, negative prompt applied to all, alt text keyword-natural.

#### 3.2 — HTML Formatter Agent
Takes approved `.md` blog + image assets and converts to styled HTML via Payload CMS API.

**Process:**
1. Parses markdown structure
2. Maps each element to Payload CMS block type:
   - Frontmatter YAML → `<head>` meta tags
   - H1/H2/H3 → heading blocks
   - Paragraphs → rich text blocks
   - Image comments → image blocks with asset URLs
   - Further Reading → link block
   - CTA section → CTA component block
3. Applies RespireLYF design system (typography, color palette, spacing)
4. Generates: preview HTML file + Payload API payload JSON

**Mini Evaluator — HTML Gate:**
Checks: all sections rendered, no broken image references, CTA button present and styled, meta tags from YAML correctly in `<head>`, mobile-responsive structure confirmed, no raw markdown syntax visible in rendered output.

### What You Need to Provide (Tier 3)
| Item | Why It's Needed |
|------|----------------|
| **Payload CMS API endpoint URL** | Where HTML Formatter posts the blog entry |
| **Payload CMS API key** | Authentication for POST requests |
| **Payload CMS block schema** | What block types exist — HTML Formatter maps markdown to these |
| **Canva Connect API key** OR **Claude API image endpoint** | Asset Generator fires prompts here |
| **RespireLYF design system** — colors, fonts, spacing tokens | Applied by HTML Formatter for consistent styling |

---

## Tier 4 — Human Review Dashboard
**Timeline: Weeks 7–8**
**Depends on: Tier 3 complete + at least 1 end-to-end blog ready for review**

### What Gets Built

#### 4.1 — Dashboard Core (Next.js)
A lightweight web dashboard — accessible by the editorial team. Shows:

**Topic Review view:**
- 5 topic cards per week with evaluator score, rationale, feature tie-in
- Quick actions: Approve / Approve with Notes / Reject + reason
- Status tracker per topic (pending → approved → in progress → ready for review)

**Blog Review view:**
- Live HTML preview of the article in an iframe — exactly as it will appear on the website
- Evaluator score card alongside the preview (all criteria, pass/fail per item)
- Section-level feedback: click any paragraph/heading to leave an inline comment
- Actions: Approve & Publish / Request Changes / Reject

**Real-time fix loop:**
- Feedback submitted → routed to the correct agent automatically:
  - Copy issue → Blog Writer Agent
  - Layout/rendering issue → HTML Formatter Agent
  - Image issue → Asset Generator Agent
- Fix applied, HTML re-rendered in dashboard within minutes
- Reviewer sees updated version without refreshing manually (WebSocket)
- Loop repeats until Approve & Publish clicked

#### 4.2 — Approval → Publish Pipeline
On approval:
1. Blog pushed to Payload CMS as a published entry
2. Slug registered in the internal blog list (for future duplicate detection)
3. Internal links on related existing articles updated if applicable
4. Notification sent to team confirming publish

### What You Need to Provide (Tier 4)
| Item | Why It's Needed |
|------|----------------|
| **Dashboard hosting** — Vercel, Netlify, or internal server | Where the Next.js dashboard is deployed |
| **Team login method** — email magic link, Google SSO, or simple password | Authentication for dashboard access |
| **Notification preference** — Slack, email, or in-app | Where publish confirmations go |

---

## Tier 5 — Full Pipeline Wiring + Monitoring
**Timeline: Week 9**
**Depends on: All tiers functional individually**

### What Gets Built
- End-to-end cron trigger: Monday 6AM → Trend Scraper fires → full pipeline runs autonomously
- Pipeline run dashboard: see every stage status, agent iteration count, evaluator score history, time per stage
- Failure alerts: if any agent exceeds max iterations or a stage is blocked, Slack alert fires immediately
- Quality metrics tracked over time: acceptance rate per stage, average iteration count, human feedback patterns, blog publish rate per week
- Threshold tuning: after 4 weeks of live data, evaluator score cutoffs adjusted based on what the human is actually approving

### What You Need to Provide (Tier 5)
| Item | Why It's Needed |
|------|----------------|
| **Monitoring preference** — Datadog, Sentry, or simple Supabase logs | Pipeline health visibility |
| **4 weeks of pipeline data** | Needed before threshold tuning can happen meaningfully |

---

## Full Requirements Checklist — What I Need From You

### Before I Can Start Building (Tier 0 — needed now)

| # | Item | Type | Urgency |
|---|------|------|---------|
| 1 | **Tech stack:** Python or TypeScript/Node.js? | Decision | 🔴 Now |
| 2 | **Deployment environment** — AWS / VPS / Vercel / local | Decision | 🔴 Now |
| 3 | **Supabase credentials** (URL + anon key + service role key) | Credentials | 🔴 Now |
| 4 | **Repo access** — existing monorepo or new repo creation | Access | 🔴 Now |

### Before Tier 1 Starts (Week 2)

| # | Item | Type | Urgency |
|---|------|------|---------|
| 5 | **SerpAPI key** (or DataForSEO key for search) | API Key | 🟡 Week 2 |
| 6 | **Reddit API credentials** (client_id, client_secret, user_agent) | API Key | 🟡 Week 2 |
| 7 | **Published blog list** — all existing slugs or URLs | Content | 🟡 Week 2 |
| 8 | **Notification method for human approval** — Slack / email / Notion | Decision | 🟡 Week 2 |

### Before Tier 2 Starts (Week 4)

| # | Item | Type | Urgency |
|---|------|------|---------|
| 9 | **DataForSEO API key** or **Ahrefs API key** | API Key | 🟠 Week 4 |
| 10 | **Claude API key** (if using Anthropic API directly) | API Key | 🟠 Week 4 |
| 11 | **RespireLYF sitemap or full blog + page URL list** | Content | 🟠 Week 4 |

### Before Tier 3 Starts (Week 6)

| # | Item | Type | Urgency |
|---|------|------|---------|
| 12 | **Payload CMS API endpoint URL** | Config | 🟠 Week 6 |
| 13 | **Payload CMS API key** | Credentials | 🟠 Week 6 |
| 14 | **Payload CMS block schema** (exported JSON or screenshot) | Config | 🟠 Week 6 |
| 15 | **Canva Connect API key** OR **Claude image API access** | API Key | 🟠 Week 6 |
| 16 | **RespireLYF design system** — hex colors, fonts, spacing | Design | 🟠 Week 6 |

### Before Tier 4 Starts (Week 7)

| # | Item | Type | Urgency |
|---|------|------|---------|
| 17 | **Dashboard hosting preference** — Vercel / internal | Decision | 🟢 Week 7 |
| 18 | **Team login method** — Google SSO / magic link / password | Decision | 🟢 Week 7 |

---

## What I Can Build Right Now (Zero Dependencies)

These agents + components require nothing from your side and can start immediately:

1. **Blog Evaluator Agent** — pure logic, entirely based on blog2.md rules already loaded
2. **Blog Writer Agent system prompt** — full prompt engineering, brand voice, FDA rules, all baked in
3. **Topic Evaluator rubric** — 5-dimension scoring logic
4. **Data contracts and shared types** — TypeScript interfaces / Python dataclasses for all agent I/O
5. **Payload CMS block mapper scaffold** — ready to wire once schema is provided
6. **Dashboard UI wireframes** — topic card view + blog review view
7. **Agent orchestration scaffold** — the plumbing that connects all stages

---

## Recommended Build Order (Week by Week)

| Week | Tier | Milestone |
|------|------|-----------|
| 1 | 0 | Repo, DB schema, env config, logging layer |
| 2 | 1 | Trend Scraper + Reddit feed — first topic signals generated |
| 3 | 1 | Topic Generator + Topic Evaluator + simple approval notification |
| 4 | 2 | SEO Research Agent + Content Brief Agent |
| 5 | 2 | Blog Writer Agent + Blog Evaluator Agent — first full draft produced |
| 6 | 3 | Asset Generator + HTML Formatter + Payload CMS integration |
| 7 | 4 | Dashboard — topic review view live |
| 8 | 4 | Dashboard — blog review view + real-time feedback loop live |
| 9 | 5 | Full pipeline wired end-to-end, cron trigger active, monitoring live |
| 10+ | — | Threshold tuning, velocity increase, quality improvement |

---

*Document generated: April 2026*  
*Next update: after Tier 0 decisions confirmed*
