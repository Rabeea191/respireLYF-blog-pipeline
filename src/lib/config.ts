/**
 * Centralised config — all env vars validated at startup.
 * Loads .env file automatically via dotenv.
 */

import { config as dotenvConfig } from "dotenv";
import path from "path";

// Load .env from project root
dotenvConfig({ path: path.join(process.cwd(), ".env") });

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional_env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const config = {
  anthropic: {
    apiKey: require_env("ANTHROPIC_API_KEY"),
    model:  optional_env("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },

  serpApi: {
    key: optional_env("SERP_API_KEY"), // optional — scraper skips if missing
  },

  reddit: {
    clientId:     optional_env("REDDIT_CLIENT_ID"),
    clientSecret: optional_env("REDDIT_CLIENT_SECRET"),
    userAgent:    optional_env("REDDIT_USER_AGENT", "RespireLYF-Pipeline/1.0"),
  },

  clickup: {
    apiKey:      require_env("CLICKUP_API_KEY"),
    listId:      require_env("CLICKUP_LIST_ID"),
    workspaceId: require_env("CLICKUP_WORKSPACE_ID"),
    webhookSecret: optional_env("CLICKUP_WEBHOOK_SECRET"),
    statuses: {
      pending:           optional_env("CLICKUP_STATUS_PENDING",        "To Review"),
      approved:          optional_env("CLICKUP_STATUS_APPROVED",       "Approved"),
      approvedWithNotes: optional_env("CLICKUP_STATUS_APPROVED_NOTES", "Approved - Needs Tweak"),
      rejected:          optional_env("CLICKUP_STATUS_REJECTED",       "Rejected"),
    },
  },

  payload: {
    url:      optional_env("PAYLOAD_URL",      "http://localhost:3000"),
    email:    optional_env("PAYLOAD_EMAIL",    ""),
    password: optional_env("PAYLOAD_PASSWORD", ""),
  },

  nanoBanana: {
    // NanoBananaAPI.ai (Gemini 2.5 Flash Image) — optional. If unset,
    // Tier 2 skips image generation and posts the draft without images.
    apiKey:  optional_env("NANO_BANANA_API_KEY"),
    baseUrl: optional_env("NANO_BANANA_BASE_URL", "https://api.nanobananaapi.ai/api/v1/nanobanana"),
  },

  pipeline: {
    approvalThreshold: parseInt(optional_env("APPROVAL_THRESHOLD", "3"), 10),
    maxTopicRetries:   parseInt(optional_env("MAX_TOPIC_RETRIES",  "3"), 10),
  },
} as const;
