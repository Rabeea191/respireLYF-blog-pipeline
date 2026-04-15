# RespireLYF Blog Pipeline

Automated multi-agent blog pipeline — Tier 0 + Tier 1 (Topic Intelligence).

## Folder Structure

```
pipeline/
├── src/
│   ├── types/index.ts              ← All shared TypeScript types
│   ├── lib/
│   │   ├── config.ts               ← Env vars (validated at startup)
│   │   ├── logger.ts               ← Structured logger
│   │   ├── claude.ts               ← Claude API wrapper
│   │   └── supabase.ts             ← DB client + query helpers
│   ├── agents/
│   │   ├── trend-scraper.ts        ← Stage 1: Google Trends + Reddit + RSS
│   │   ├── topic-generator.ts      ← Stage 2: 5 topic candidates/week
│   │   ├── topic-refiner.ts        ← Stage 5: Apply human feedback
│   ├── evaluators/
│   │   ├── trend-gate.ts           ← Mini evaluator: score + filter signals
│   │   └── topic-gate.ts           ← Mini evaluator: score + flag topics
│   ├── notifications/
│   │   └── clickup.ts              ← Post topic cards to ClickUp
│   ├── api/
│   │   ├── cron-trigger.ts         ← Vercel cron endpoint (Monday 6AM)
│   │   └── clickup-webhook.ts      ← Receives human approval from ClickUp
│   └── pipeline/
│       └── tier1-orchestrator.ts   ← Ties everything together
├── supabase/
│   └── schema.sql                  ← Run this once in Supabase SQL editor
├── vercel.json                     ← Cron schedule + function config
└── .env.example                    ← Copy to .env.local and fill in
```

## Setup (Step by Step)

### 1. Install dependencies
```bash
cd pipeline
npm install
```

### 2. Set up Supabase
1. Go to your Supabase project → SQL Editor
2. Run the contents of `supabase/schema.sql`
3. Copy your project URL + anon key + service role key

### 3. Set up ClickUp
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

### 4. Configure environment
```bash
cp .env.example .env.local
# Fill in all values
```

### 5. Deploy to Vercel
```bash
vercel deploy
```
Set all env vars in Vercel Dashboard → Project → Settings → Environment Variables.
The cron job (`vercel.json`) will fire automatically every Monday at 6AM UTC.

### 6. Test manually
```bash
curl -X POST https://your-app.vercel.app/api/pipeline/trigger \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

## How the Approval Flow Works

1. Every Monday 6AM → pipeline scrapes trends, generates 5 topic cards
2. Each topic appears as a ClickUp task in "Blog Topic Review" list
3. Reviewer changes task status:
   - **Approved** → topic moves to Tier 2 (SEO research)
   - **Approved - Needs Tweak** → add a comment with your notes → Topic Refiner applies them → auto-advances
   - **Rejected** → add a comment explaining why → pipeline regenerates a replacement
4. When ≥3 topics are approved → Tier 2 starts automatically

## What's Coming (Tier 2+)

- **Tier 2**: SEO Research Agent + Content Brief Agent + Blog Writer Agent + Blog Evaluator
- **Tier 3**: Asset Generator (Canva/Claude images) + HTML Formatter + Payload CMS
- **Tier 4**: Human Review Dashboard with live HTML preview + real-time feedback loop
- **Tier 5**: Full monitoring, threshold tuning, publish automation
