/**
 * Reset tier2_processed_at markers on all Approved ClickUp topic tasks.
 *
 * Run this when Tier 2 processed topics but the CMS posts failed (e.g. bad
 * Payload creds) — it lets the next tier2-trigger pick them up again and
 * re-post. Only touches tasks whose status is Approved / Approved-with-Notes
 * and which have an embedded topic JSON block.
 *
 * Usage:
 *   npx tsx scripts/reset-tier2-markers.ts
 *
 * Requires the same .env as the rest of the pipeline (CLICKUP_API_KEY,
 * CLICKUP_LIST_ID, etc.) — dotenv is loaded by src/lib/config.ts.
 */

import axios from "axios";
import { config } from "../src/lib/config";
import {
  extractEmbeddedTopic,
  buildEmbeddedTopicBlock,
  TOPIC_BLOCK_OPEN,
} from "../src/lib/topic-embed";
import type { TopicCard } from "../src/types";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const headers = {
  Authorization: config.clickup.apiKey,
  "Content-Type": "application/json",
};

interface ClickUpTask {
  id: string;
  name: string;
  status?: { status: string };
  description?: string;
  text_content?: string;
}

async function main() {
  console.log("Fetching tasks from ClickUp list…");
  const { data } = await axios.get(
    `${CLICKUP_BASE}/list/${config.clickup.listId}/task`,
    {
      headers,
      params: { include_closed: false, subtasks: false, page: 0 },
      timeout: 30_000,
    },
  );

  const tasks: ClickUpTask[] = data?.tasks ?? [];
  console.log(`Fetched ${tasks.length} tasks`);

  const approvedLower = config.clickup.statuses.approved.toLowerCase();
  const notesLower    = config.clickup.statuses.approvedWithNotes.toLowerCase();

  let reset = 0;
  let skipped = 0;

  for (const task of tasks) {
    const status = (task.status?.status ?? "").toLowerCase();
    if (status !== approvedLower && status !== notesLower) {
      skipped++;
      continue;
    }

    const rawDescription = task.description ?? task.text_content ?? "";
    const topic = extractEmbeddedTopic(rawDescription);
    if (!topic) {
      console.log(`  - ${task.id} "${task.name}": no embedded topic, skipping`);
      skipped++;
      continue;
    }

    if (!topic.tier2_processed_at) {
      console.log(`  - ${task.id} "${topic.title}": not processed, skipping`);
      skipped++;
      continue;
    }

    // Strip tier2_processed_at, rewrite the embedded block.
    const cleanTopic: TopicCard = { ...topic };
    delete cleanTopic.tier2_processed_at;

    const blockStart = rawDescription.indexOf(TOPIC_BLOCK_OPEN);
    const beforeBlock = blockStart === -1 ? rawDescription : rawDescription.slice(0, blockStart);
    const newDescription = beforeBlock.trimEnd() + buildEmbeddedTopicBlock(cleanTopic);

    try {
      await axios.put(
        `${CLICKUP_BASE}/task/${task.id}`,
        { description: newDescription },
        { headers, timeout: 15_000 },
      );
      console.log(`  ✓ ${task.id} "${topic.title}": reset`);
      reset++;
    } catch (err: any) {
      console.error(`  ✗ ${task.id} "${topic.title}": failed to reset — ${err.message}`);
    }
  }

  console.log("\n────────────────────────────────");
  console.log(`Reset:    ${reset}`);
  console.log(`Skipped:  ${skipped}`);
  console.log("────────────────────────────────");
  console.log(
    `\nNow trigger the pipeline again:\n  curl.exe -X POST https://YOUR_URL.vercel.app/api/pipeline/tier2-trigger -H "Authorization: Bearer $CRON_SECRET"`,
  );
}

main().catch((err) => {
  console.error("Reset script failed:", err.message);
  process.exit(1);
});
