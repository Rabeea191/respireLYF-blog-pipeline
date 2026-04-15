/**
 * Claude API wrapper — all agent LLM calls go through here.
 * Handles retries, token tracking, and structured JSON output.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { logger } from "./logger";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

interface CallOptions {
  stage: string;
  system: string;
  user: string;
  run_id?: string;
  temperature?: number;
  max_tokens?: number;
}

interface ClaudeResponse {
  text: string;
  tokens_used: number;
  duration_ms: number;
}

/**
 * Base call — returns raw text. All other helpers build on this.
 */
export async function callClaude(opts: CallOptions): Promise<ClaudeResponse> {
  const start = Date.now();
  logger.debug(opts.stage, "Calling Claude", { run_id: opts.run_id });

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: opts.max_tokens ?? 4096,
    temperature: opts.temperature ?? 0.3,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const tokens_used =
    (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  const duration_ms = Date.now() - start;

  logger.debug(opts.stage, `Claude responded`, {
    run_id: opts.run_id,
    data: { tokens_used, duration_ms },
  });

  return { text, tokens_used, duration_ms };
}

/**
 * Structured JSON call — parses the response as JSON.
 * Claude is instructed to return ONLY valid JSON.
 */
export async function callClaudeJSON<T>(
  opts: CallOptions & { schema_hint?: string }
): Promise<T & { _tokens_used: number; _duration_ms: number }> {
  const system = `${opts.system}

CRITICAL OUTPUT RULE: Your entire response must be valid JSON only.
No markdown code blocks. No explanation text before or after.
Just the raw JSON object.${opts.schema_hint ? `\n\nExpected schema:\n${opts.schema_hint}` : ""}`;

  const result = await callClaude({ ...opts, system });

  try {
    // Strip any accidental markdown fences
    const cleaned = result.text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as T;
    return {
      ...parsed,
      _tokens_used: result.tokens_used,
      _duration_ms: result.duration_ms,
    };
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
