/**
 * Claude API wrapper — all agent LLM calls go through here.
 * Handles retries, token tracking, and structured JSON output.
 *
 * Supports two call signatures:
 *   1. Options object:  callClaude({ stage, system, user, ... })
 *   2. Positional args: callClaude(system, user)  → returns Promise<string>
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { logger } from "./logger";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// ─── Global token counter ────────────────────────────────────────────────────

let _totalInputTokens  = 0;
let _totalOutputTokens = 0;

export function resetTokenStats() {
  _totalInputTokens  = 0;
  _totalOutputTokens = 0;
}

/**
 * Returns cumulative token usage and estimated USD cost.
 * Pricing: claude-sonnet-4-6 — $3/M input, $15/M output
 */
export function getTokenStats() {
  const inputCost  = (_totalInputTokens  / 1_000_000) * 3;
  const outputCost = (_totalOutputTokens / 1_000_000) * 15;
  return {
    input_tokens:  _totalInputTokens,
    output_tokens: _totalOutputTokens,
    total_tokens:  _totalInputTokens + _totalOutputTokens,
    cost_usd:      parseFloat((inputCost + outputCost).toFixed(4)),
    breakdown:     `$${inputCost.toFixed(4)} input + $${outputCost.toFixed(4)} output`,
  };
}

export interface CallOptions {
  stage: string;
  system: string;
  user: string;
  run_id?: string;
  temperature?: number;
  max_tokens?: number;
  iteration?: number;
  schema_hint?: string;
}

export interface ClaudeResponse {
  text: string;
  tokens_used: number;
  duration_ms: number;
}

// ─── Internal base call ───────────────────────────────────────────────────────

async function _callClaude(opts: CallOptions): Promise<ClaudeResponse> {
  const start = Date.now();
  logger.info(opts.stage || "claude", "Calling Claude", { run_id: opts.run_id });

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: opts.max_tokens ?? 4096,
    temperature: opts.temperature ?? 0.3,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const inputTok  = response.usage?.input_tokens  ?? 0;
  const outputTok = response.usage?.output_tokens ?? 0;
  _totalInputTokens  += inputTok;
  _totalOutputTokens += outputTok;
  const tokens_used = inputTok + outputTok;
  const duration_ms = Date.now() - start;

  logger.info(opts.stage || "claude", `Claude responded`, {
    run_id: opts.run_id,
    data: { tokens_used, duration_ms },
  });

  return { text, tokens_used, duration_ms };
}

// ─── callClaude — overloaded ──────────────────────────────────────────────────

/**
 * Options-object form → returns full ClaudeResponse
 */
export async function callClaude(opts: CallOptions): Promise<ClaudeResponse>;

/**
 * Positional form → returns plain string (convenience wrapper)
 */
export async function callClaude(
  system: string,
  user: string,
  _modelIgnored?: string
): Promise<string>;

export async function callClaude(
  optsOrSystem: CallOptions | string,
  user?: string,
  _modelIgnored?: string
): Promise<ClaudeResponse | string> {
  if (typeof optsOrSystem === "string") {
    // Positional call → return plain string
    const result = await _callClaude({
      stage: "claude",
      system: optsOrSystem,
      user: user ?? "",
    });
    return result.text;
  }
  return _callClaude(optsOrSystem);
}

// ─── callClaudeJSON — overloaded ──────────────────────────────────────────────

/**
 * Options-object form → returns parsed T (with _tokens_used, _duration_ms)
 */
export async function callClaudeJSON<T>(
  opts: CallOptions
): Promise<T>;

/**
 * Positional form → returns parsed T
 */
export async function callClaudeJSON<T>(
  system: string,
  user: string,
  _modelIgnored?: string
): Promise<T>;

export async function callClaudeJSON<T>(
  optsOrSystem: CallOptions | string,
  user?: string,
  _modelIgnored?: string
): Promise<T> {
  let opts: CallOptions;

  if (typeof optsOrSystem === "string") {
    opts = { stage: "claude", system: optsOrSystem, user: user ?? "" };
  } else {
    opts = optsOrSystem;
  }

  const jsonSystemPrompt = `${opts.system}

CRITICAL OUTPUT RULE: Your entire response must be valid JSON only.
No markdown code blocks. No explanation text before or after.
Just the raw JSON object.${opts.schema_hint ? `\n\nExpected schema:\n${opts.schema_hint}` : ""}`;

  const result = await _callClaude({ ...opts, system: jsonSystemPrompt });

  try {
    const cleaned = result.text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    return JSON.parse(cleaned) as T;
  } catch (err) {
    logger.error(opts.stage, "Failed to parse Claude JSON response", {
      run_id: opts.run_id,
      data: { raw: result.text.slice(0, 500), error: String(err) },
    });
    throw new Error(
      `Claude returned invalid JSON at stage '${opts.stage}'. Raw: ${result.text.slice(0, 200)}`
    );
  }
}
