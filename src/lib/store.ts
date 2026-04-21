/**
 * Simple file-based store for local pipeline runs.
 * Saves state to ./pipeline-data/ as JSON files.
 * No database needed for local testing.
 *
 * On Vercel, filesystem is read-only except /tmp, so writes are routed there.
 * Since ClickUp is the source of truth for topics and Payload is the source of
 * truth for drafts, this store is purely for CLI/debug convenience — if writes
 * fail we log-and-continue instead of crashing the pipeline.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import type { PipelineRun, TopicCard, TrendSignal } from "../types";

// On Vercel, cwd is read-only — route writes to /tmp which is writable.
const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DATA_DIR = IS_SERVERLESS
  ? path.join(os.tmpdir(), "pipeline-data")
  : path.join(process.cwd(), "pipeline-data");

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn(`[store] mkdir failed (${DATA_DIR}): ${String(err)} — continuing without persistence`);
  }
}

function write(filename: string, data: unknown) {
  try {
    ensureDir();
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[store] write ${filename} failed: ${String(err)} — continuing`);
  }
}

function read<T>(filename: string): T | null {
  try {
    const fp = path.join(DATA_DIR, filename);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as T;
  } catch (err) {
    console.warn(`[store] read ${filename} failed: ${String(err)}`);
    return null;
  }
}

// ─── Pipeline Runs ────────────────────────────────────────────────────────────

export async function createPipelineRun(data: Omit<PipelineRun, "id">): Promise<PipelineRun> {
  const run: PipelineRun = { id: randomUUID(), ...data };
  write(`run-${run.id}.json`, run);
  write("latest-run.json", run);
  console.log(`[store] Created pipeline run: ${run.id}`);
  return run;
}

export async function updatePipelineRun(
  id: string,
  updates: Partial<PipelineRun>
): Promise<PipelineRun> {
  const existing = read<PipelineRun>(`run-${id}.json`) ?? ({ id } as PipelineRun);
  const updated = { ...existing, ...updates };
  write(`run-${id}.json`, updated);
  write("latest-run.json", updated);
  return updated;
}

export async function getPipelineRun(id: string): Promise<PipelineRun | null> {
  return read<PipelineRun>(`run-${id}.json`);
}

// ─── Trend Signals ────────────────────────────────────────────────────────────

export async function saveTrendSignals(signals: TrendSignal[]): Promise<void> {
  write("latest-signals.json", signals);
  console.log(`[store] Saved ${signals.length} trend signals`);
}

// ─── Topic Cards ──────────────────────────────────────────────────────────────

export async function saveTopicCards(cards: TopicCard[]): Promise<void> {
  write("latest-topics.json", cards);
  // Also save individually for lookup
  for (const card of cards) {
    write(`topic-${card.id}.json`, card);
  }
  console.log(`[store] Saved ${cards.length} topic cards`);
}

export async function updateTopicCard(
  id: string,
  updates: Partial<TopicCard>
): Promise<TopicCard> {
  const existing = read<TopicCard>(`topic-${id}.json`) ?? ({ id } as TopicCard);
  const updated = { ...existing, ...updates };
  write(`topic-${id}.json`, updated);
  // Update in latest-topics list too
  const all = read<TopicCard[]>("latest-topics.json") ?? [];
  const idx = all.findIndex((c) => c.id === id);
  if (idx !== -1) { all[idx] = updated; write("latest-topics.json", all); }
  return updated;
}

export async function getTopicCard(id: string): Promise<TopicCard | null> {
  return read<TopicCard>(`topic-${id}.json`);
}

// ─── Published slugs (from local blogs/ folder) ───────────────────────────────

export async function getPublishedSlugs(): Promise<string[]> {
  // On serverless we have no local blogs/ folder — return empty so the topic
  // generator simply trusts the de-dup logic downstream (ClickUp + Payload).
  if (IS_SERVERLESS) return [];
  try {
    const blogsDir = path.join(process.cwd(), "blogs");
    if (!fs.existsSync(blogsDir)) return [];
    return fs.readdirSync(blogsDir).filter((f) =>
      fs.statSync(path.join(blogsDir, f)).isDirectory()
    );
  } catch (err) {
    console.warn(`[store] getPublishedSlugs failed: ${String(err)}`);
    return [];
  }
}
