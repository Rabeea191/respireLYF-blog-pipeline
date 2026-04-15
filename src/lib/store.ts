/**
 * Simple file-based store for local pipeline runs.
 * Saves state to ./pipeline-data/ as JSON files.
 * No database needed for local testing.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { PipelineRun, TopicCard, TrendSignal } from "../types";

const DATA_DIR = path.join(process.cwd(), "pipeline-data");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function write(filename: string, data: unknown) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), "utf-8");
}

function read<T>(filename: string): T | null {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as T;
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
  const blogsDir = path.join(process.cwd(), "blogs");
  if (!fs.existsSync(blogsDir)) return [];
  return fs.readdirSync(blogsDir).filter((f) =>
    fs.statSync(path.join(blogsDir, f)).isDirectory()
  );
}
