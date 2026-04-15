/**
 * Centralised config — all env vars validated at startup.
 * If a required variable is missing the process exits immediately with a clear error.
 */

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
    model: optional_env("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },

  supabase: {
    url: require_env("SUPABASE_URL"),
    anonKey: require_env("SUPABASE_ANON_KEY"),
    serviceRoleKey: require_env("SUPABASE_SERVICE_ROLE_KEY"),
  },

  serpApi: {
    key: require_env("SERP_API_KEY"),
  },

  reddit: {
    clientId: require_env("REDDIT_CLIENT_ID"),
    clientSecret: require_env("REDDIT_CLIENT_SECRET"),
    userAgent: optional_env("REDDIT_USER_AGENT", "RespireLYF-Pipeline/1.0"),
  },

  clickup: {
    apiKey: require_env("CLICKUP_API_KEY"),
    listId: require_env("CLICKUP_LIST_ID"),        // The list where topic cards are created
    workspaceId: require_env("CLICKUP_WORKSPACE_ID"),
    webhookSecret: optional_env("CLICKUP_WEBHOOK_SECRET"),
    // Status names — must match exactly what's configured in your ClickUp list
    statuses: {
      pending:             optional_env("CLICKUP_STATUS_PENDING",           "To Review"),
      approved:            optional_env("CLICKUP_STATUS_APPROVED",          "Approved"),
      approvedWithNotes:   optional_env("CLICKUP_STATUS_APPROVED_NOTES",    "Approved - Needs Tweak"),
      rejected:            optional_env("CLICKUP_STATUS_REJECTED",          "Rejected"),
    },
  },

  pipeline: {
    approvalThreshold: parseInt(optional_env("APPROVAL_THRESHOLD", "3"), 10),
    maxTopicRetries: parseInt(optional_env("MAX_TOPIC_RETRIES", "3"), 10),
    appUrl: optional_env("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),
  },
} as const;
