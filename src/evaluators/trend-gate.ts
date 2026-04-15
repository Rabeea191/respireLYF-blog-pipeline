/**
 * Tier 1 — Trend Gate (Mini Evaluator)
 *
 * Scores each TrendSignal on three dimensions (1–5 each, 15 max).
 * Drops signals below threshold. Passes top N downstream.
 *
 * Scoring dimensions:
 *   1. Patient intent    — does this reflect a real patient search query?
 *   2. Brand relevance   — can RespireLYF address this meaningfully?
 *   3. Seasonality fit   — is timing right for this week?
 */

import { callClaudeJSON } from "../lib/claude";
import { logger } from "../lib/logger";
import type { TrendSignal } from "../types";

const GATE_THRESHOLD = 9;   // out of 15 — drop below this
const MAX_PASS = 15;        // keep top 15 signals maximum

interface TrendGateScores {
  patient_intent: number;   // 1–5
  brand_relevance: number;  // 1–5
  seasonality_fit: number;  // 1–5
  reasoning: string;        // one line
}

const SYSTEM_PROMPT = `You are the Trend Gate evaluator for RespireLYF — an AI-powered respiratory health app for US adults with asthma or COPD.

Your job: score each raw trend signal on three dimensions (1–5 each).

SCORING GUIDE:

patient_intent (1–5):
  5 = Exact patient question a sufferer would Google ("why does cold air trigger my asthma")
  4 = Clear patient concern, slightly indirect ("asthma cold weather")
  3 = Relevant but could be caregiver, student, or general interest
  2 = Mostly institutional/news, minor patient relevance
  1 = No patient search intent (press release, research abstract title)

brand_relevance (1–5):
  5 = RespireLYF directly addresses this — we track this exact determinant or indicator
      (food, sleep, stress, weather, cough, peak flow, inhaler, activity, hydration, vitals)
  4 = Strong indirect fit — the topic connects to a feature we can mention naturally
  3 = Moderate fit — we can reference MD-RIC or general pattern tracking
  2 = Weak fit — tangentially respiratory but hard to connect to RespireLYF features
  1 = No fit — unrelated to our product features

seasonality_fit (1–5):
  5 = Peak timing — this is exactly what patients are searching right now this week
  4 = Good timing — relevant this month
  3 = Evergreen — always relevant, no seasonal bonus
  2 = Off-season — would be better in a different month
  1 = Wrong season entirely

Return ONLY a JSON array — one object per signal, in the same order as input.`;

export async function runTrendGate(
  signals: TrendSignal[],
  run_id: string
): Promise<TrendSignal[]> {
  if (signals.length === 0) return [];

  logger.info("trend_gate", `Scoring ${signals.length} signals`, { run_id });

  // Batch into groups of 20 to stay within token limits
  const BATCH_SIZE = 20;
  const batches: TrendSignal[][] = [];
  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    batches.push(signals.slice(i, i + BATCH_SIZE));
  }

  const scoredSignals: TrendSignal[] = [];

  for (const batch of batches) {
    const input = batch.map((s, idx) => ({
      idx,
      query: s.raw_query,
      source: s.source.name,
      patient_intent_flag: s.patient_intent_flag,
      trend_direction: s.trend_direction,
      seasonal_context: s.seasonal_context_tag ?? "none",
    }));

    const results = await callClaudeJSON<TrendGateScores[]>({
      stage: "trend_gate",
      run_id,
      system: SYSTEM_PROMPT,
      user: `Score these ${batch.length} trend signals:\n\n${JSON.stringify(input, null, 2)}`,
      temperature: 0.1,
      schema_hint: `Array of { patient_intent: number, brand_relevance: number, seasonality_fit: number, reasoning: string }`,
    });

    const scoresArray = Array.isArray(results) ? results : [];

    batch.forEach((signal, idx) => {
      const scores = scoresArray[idx];
      if (!scores) {
        scoredSignals.push({ ...signal, passed_gate: false });
        return;
      }

      const total = scores.patient_intent + scores.brand_relevance + scores.seasonality_fit;
      scoredSignals.push({
        ...signal,
        gate_scores: {
          patient_intent: scores.patient_intent,
          brand_relevance: scores.brand_relevance,
          seasonality_fit: scores.seasonality_fit,
          total,
        },
        passed_gate: total >= GATE_THRESHOLD,
      });
    });
  }

  // Sort by total score descending, keep top MAX_PASS that passed
  const passed = scoredSignals
    .filter((s) => s.passed_gate)
    .sort((a, b) => (b.gate_scores?.total ?? 0) - (a.gate_scores?.total ?? 0))
    .slice(0, MAX_PASS);

  const failed = scoredSignals.filter((s) => !s.passed_gate).length;

  logger.info("trend_gate", `Gate result: ${passed.length} passed, ${failed} dropped`, { run_id });

  return [...passed, ...scoredSignals.filter((s) => !s.passed_gate)];
}
