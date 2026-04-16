/**
 * RespireLYF Blog Pipeline — Shared Type Contracts
 * Every agent reads and writes these types. No ad-hoc shapes anywhere.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

export type TopicType =
  | "trigger_pattern"
  | "copd_specific"
  | "tracking_management"
  | "cough_specific"
  | "lifestyle_factor";

export type IntentStrength = "high" | "medium" | "low";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "approved_with_notes"
  | "rejected"
  | "regenerating";

export type PipelineStage =
  | "trend_scraping"
  | "topic_generation"
  | "topic_evaluation"
  | "human_approval"
  | "topic_refinement"
  | "seo_research"
  | "content_brief"
  | "blog_writing"
  | "blog_evaluation"
  | "asset_generation"
  | "html_formatting"
  | "human_review"
  | "published";

export type PipelineRunStatus =
  | "running"
  | "awaiting_approval"
  | "approved"
  | "blocked"
  | "completed"
  | "failed";

// ─── Trend Scraper ────────────────────────────────────────────────────────────

export interface TrendSource {
  name: "google_trends" | "reddit" | "rss_cdc" | "rss_nhlbi" | "rss_epa";
  url?: string;
}

export interface TrendSignal {
  id: string;
  raw_query: string;
  source: TrendSource;
  trend_direction: "rising" | "stable" | "declining";
  patient_intent_flag: boolean;
  seasonal_context_tag?: string; // e.g. "allergy_season", "wildfire_season", "winter"
  scraped_at: string; // ISO timestamp
  // Set by TrendGate evaluator
  gate_scores?: {
    patient_intent: number;   // 1–5
    brand_relevance: number;  // 1–5
    seasonality_fit: number;  // 1–5
    total: number;            // /15
  };
  passed_gate: boolean;
}

// ─── Topic Cards ─────────────────────────────────────────────────────────────

/** The RespireLYF feature → topic mapping from blog2.md */
export type RespireLYFFeature =
  | "Sleep HD tracking + peak flow correlation"
  | "Food HD + MD-RIC pattern detection"
  | "Stress HD + Breathing Score"
  | "Weather & Environment HD (auto-tracked)"
  | "Passive cough tracking (wet/dry, on-device ML)"
  | "Peak Flow HI + trend visualization"
  | "Inhaler technique detection via Apple Watch"
  | "Breathing Fingerprint + MD-RIC daily MEEPs"
  | "LYF Hub supplement recommendations"
  | "Hydration HD"
  | "Activity HD + Breathing Score";

export interface TopicCard {
  id: string;
  pipeline_run_id: string;
  title: string;                    // Must be under 60 chars
  primary_keyword: string;          // Patient-language search query
  rationale: string;                // Why this week — trend + seasonality
  respireLYF_feature: RespireLYFFeature;
  intent_strength: IntentStrength;
  topic_type: TopicType;
  ymyl_flag: boolean;               // Requires "When to See a Doctor" section
  source_signal_ids: string[];      // Which TrendSignals informed this topic
  generated_at: string;
  iteration_count: number;          // How many times regenerated
  // Set by TopicEvaluator
  evaluation?: TopicEvaluation;
  // Set by human
  approval_status: ApprovalStatus;
  human_notes?: string;
  // Set by TopicRefiner if notes provided
  refined_at?: string;
  // Set after posting to ClickUp
  clickup_task_id?: string;
}

// ─── Topic Evaluation ─────────────────────────────────────────────────────────

export interface TopicEvaluation {
  topic_id: string;
  scores: {
    seo_potential: number;              // 1–10
    brand_fit: number;                  // 1–10
    reader_urgency: number;             // 1–10
    content_differentiation: number;   // 1–10
    fda_safe_angle: number;             // 1–10
    total: number;                      // /50
  };
  editorial_note: string;               // 2-sentence summary for human
  gate_flag: "clean" | "caution" | "revise";
  evaluated_at: string;
}

// ─── SEO Package (Tier 2) ─────────────────────────────────────────────────────

export interface SEOPackage {
  topic_id: string;
  primary_keyword: string;
  secondary_keywords: string[];         // 4–5 semantically related
  keyword_difficulty_estimate: "low" | "medium" | "high";
  competitor_urls: Array<{
    url: string;
    gap_note: string;                   // What they're missing that we can own
  }>;
  suggested_h2_outline: string[];       // 3–5 headings
  internal_links: Array<{
    anchor_text: string;
    url: string;
  }>;
  outbound_links: Array<{
    anchor_text: string;
    url: string;
    source_org: "CDC" | "NIH" | "NHLBI" | "GINA" | "GOLD" | "FDA" | "AJRCCM" | "NEJM" | "JAMA" | "Chest" | "Lancet";
  }>;
  ymyl_confirmed: boolean;
  researched_at: string;
}

// ─── Content Brief (Tier 2) ───────────────────────────────────────────────────

export interface ContentBrief {
  topic_id: string;
  seo_package_id: string;
  yaml_frontmatter: {
    meta_title: string;                 // 55–60 chars
    meta_description: string;          // 140–155 chars
    primary_keyword: string;
    secondary_keywords: string[];
    slug: string;
  };
  h1: string;
  h2_outline: Array<{
    heading: string;
    keyword_notes?: string;
    missing_from_competitors?: boolean;
  }>;
  word_count_target: { min: 800; max: 1200 };
  feature_to_highlight: RespireLYFFeature;
  opening_angle: string;               // Exact frustration to name first
  ymyl_section_required: boolean;
  tone_note: string;                   // Article-specific tone guidance
  fda_red_flags: string[];             // Phrases to avoid for this topic
  created_at: string;
}

// ─── Blog Draft (Tier 2) ──────────────────────────────────────────────────────

export interface BlogDraft {
  id: string;
  topic_id: string;
  brief_id: string;
  markdown_content: string;
  word_count: number;
  file_path: string;                   // blogs/[slug]/[slug].md
  iteration_count: number;
  evaluation?: BlogEvaluation;
  created_at: string;
  updated_at: string;
}

export interface BlogEvaluation {
  draft_id: string;
  hard_fails: Array<{
    rule: string;
    details: string;
  }>;
  soft_scores: {
    opening_hook: number;             // 1–10
    product_intro_naturalness: number; // 1–10
    tone_quality: number;             // 1–10
    total: number;                    // /30
  };
  passed: boolean;
  feedback_for_writer: string;
  evaluated_at: string;
}

// ─── Pipeline Run ─────────────────────────────────────────────────────────────

export interface PipelineRun {
  id: string;
  week_of: string;                     // ISO date of Monday this run covers
  status: PipelineRunStatus;
  current_stage: PipelineStage;
  topic_cards: TopicCard[];
  approved_count: number;
  approval_threshold: number;
  stage_log: PipelineStageLog[];
  started_at: string;
  completed_at?: string;
}

export interface PipelineStageLog {
  stage: PipelineStage;
  status: "running" | "completed" | "failed" | "skipped";
  iteration: number;
  agent_input_summary?: string;
  agent_output_summary?: string;
  evaluator_result?: string;
  error?: string;
  duration_ms?: number;
  timestamp: string;
}

// ─── Agent Result wrapper ─────────────────────────────────────────────────────

export interface AgentResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  iteration: number;
  tokens_used?: number;
  duration_ms: number;
}
