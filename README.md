# Respire LYF Blog Pipeline

Automated end-to-end blog pipeline — trend scraping → topic generation → human approval in ClickUp → SEO research → brief → AI writing → evaluator loop → image generation → Payload CMS draft. No database: **ClickUp is the source of truth for topics, Payload is the source of truth for drafts**.

## Folder Structure

```
pipeline/
├── src/
│   ├── types/index.ts              ← All shared TypeScript types
│   ├── lib/
│   │   ├── config.ts               ← Env vars (validated at startup)
│   │   ├── logger.ts               ← Structured logger
│   │   ├── claude.ts               ← Claude API wrapper + token accounting
│   │   ├── store.ts                ← Local JSON store (for CLI/debug)
│   │   ├── topic-embed.ts          ← Shared JSON-in-ClickUp helpers
│   │   └── image-pipeline.ts       ← NanoBanana → Payload Media
│   ├── agents/
│   │   ├── trend-scraper.ts        ← Stage 1: Google Trends + Reddit + RSS
│   │   ├── topic-generator.ts      ← Stage 2: 5 topic candidates/week
│   │   ├── topic-refiner.ts        ← Stage 5: Apply human feedback
│   │   ├── seo-researcher.ts       ← Stage 6: SEO package
│   │   ├── content-brief.ts        ← Stage 7: Content brief + outline
│   │   ├── blog-writer.ts          ← Stage 9: Draft the blog
│   │   └── payload-poster.ts       ← Stage 11: Post draft + images to Payload
│   ├── evaluators/
│   │   ├── trend-gate.ts           ← Score + filter trend signals
│   │   ├── topic-gate.ts           ← Score + flag topics
│   │   └── blog-gate.ts            ← Stage 10: Writer ↔ evaluator loop
│   ├── notifications/
│   │   └── clickup.ts              ← Post topic cards (with embedded JSON) to ClickUp
│   ├── api/
│   │   ├── cron-trigger.ts         ← POST /api/pipeline/trigger (Monday 6AM)
│   │   ├── clickup-webhook.ts      ← POST /api/pipeline/clickup-webhook
│   │   └── tier2-trigger.ts        ← POST /api/pipeline/tier2-trigger
│   └── pipeline/
│       ├── tier1-orchestrator.ts   ← Trends → Topics → ClickUp
│       └── tier2-orchestrator.ts   ← ClickUp → SEO → Brief → Write → Payload
├── post-blog.js                    ← Legacy standalone CLI poster (still works)
├── vercel.json                     ← Cron + function config
└── .env.example                    ← Copy to .env and fill in
```

## Setup (Step by Step)

### 1. Install dependencies
```bash
cd pipeline
npm install
```

### 2. Set up ClickUp
1. Create a new **List** in ClickUp called "Blog Topic Review"
2. Add these custom statuses to the list:
   - `To Review` (default)
   - `Approved`
   - `Approved - Needs Tweak`
   - `Rejected`
3. Get your API key from ClickUp → Settings → My Apps → API
4. Copy the List ID from the list URL (the number in the URL)
5. Set up a Webhook: ClickUp → Settings → Integrations → Webhooks
   - URL: `https://your-app.vercel.app/api/pipeline/clickup-webhook`
   - Events: `taskStatusUpdated`, `taskCommentPosted`

### 3. Set up Payload CMS
1. Make sure your Payload site has a `blog` collection with the Drafts plugin enabled
2. Create a service admin account and note the email / password — Tier 2 logs in with it to create drafts and upload media
3. Put the Payload base URL (e.g. `https://www.respirelyf.com`) in `PAYLOAD_URL`

### 4. (Optional) Set up NanoBanana for inline images
1. Get an API key at [nanobananaapi.ai](https://nanobananaapi.ai)
2. Set `NANO_BANANA_API_KEY` in `.env`
3. If unset, Tier 2 still works — it just drafts blogs without generated images

### 5. Configure environment
```bash
cp .env.example .env
# Fill in all values
```

### 6. Deploy to Vercel
```bash
vercel deploy
```
Set all env vars in Vercel Dashboard → Project → Settings → Environment Variables.
The cron job in `vercel.json` fires Tier 1 automatically every Monday at 6AM UTC.

### 7. Test manually
```bash
# Kick off Tier 1 (trends → topics → ClickUp)
curl -X POST https://your-app.vercel.app/api/pipeline/trigger \
  -H "Authorization: Bearer YOUR_CRON_SECRET"

# Force Tier 2 (pulls approved tasks from ClickUp and drafts blogs)
curl -X POST https://your-app.vercel.app/api/pipeline/tier2-trigger \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

## How the End-to-End Flow Works

1. **Monday 6AM cron** → Vercel hits `/api/pipeline/trigger` → Tier 1 orchestrator runs
2. Tier 1 scrapes trends, generates 5 topic cards, posts each as a ClickUp task
3. Each task description embeds the full TopicCard as a hidden JSON block (so ClickUp is the source of truth — no database)
4. Human reviewer flips each task's status:
   - **Approved** → topic is eligible for Tier 2
   - **Approved - Needs Tweak** → add a comment with notes → webhook runs Topic Refiner → task auto-advances to Approved
   - **Rejected** → topic is excluded
5. The webhook counts Approved tasks after each status change. When the count hits `APPROVAL_THRESHOLD` (default 3), it fires `/api/pipeline/tier2-trigger`
6. Tier 2 loads every Approved task from ClickUp, parses the embedded JSON, and for each topic runs: SEO research → content brief → writer ↔ evaluator loop (max 3 iterations) → NanoBanana image generation → Payload Media upload → `blog` draft creation
7. The draft lands in Payload with `_status: "draft"` — a human reviews and clicks Publish when ready

## Source-of-Truth Rule

- **ClickUp** holds every topic's state (pending / approved / rejected). The hidden JSON block in the task description carries the full TopicCard, so Tier 2 rehydrates it without a database.
- **Payload** holds every blog draft. The pipeline never overwrites a human-edited post — existing drafts are updated in place only, and `_status` is never demoted from published back to draft.

## Local CLI

For development or manual reruns:

```bash
# Tier 1 only (writes topics to local pipeline-data/ + posts to ClickUp)
npm run tier1

# Tier 2 only (pulls approved topics from ClickUp and drafts blogs)
npm run tier2

# Post a single existing blog .md (legacy, still useful for ad-hoc drafts)
npm run post-blog -- --slug your-blog-slug
```
