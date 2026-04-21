/**
 * Tier 1 — Trend Scraper Agent
 *
 * Scrapes 4 sources every Monday:
 *   1. SerpAPI Google Trends
 *   2. Reddit r/Asthma + r/COPD (top posts, last 7 days)
 *   3. CDC RSS feed
 *   4. NHLBI RSS feed
 *
 * Returns raw TrendSignal[] — unscored, unfiltered.
 * The TrendGate evaluator scores and filters them next.
 */

import axios from "axios";
import Parser from "rss-parser";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import type { TrendSignal, TrendSource } from "../types";
import { randomUUID } from "crypto";

const rssParser = new Parser({
  timeout: 8000, // 8s per feed — serverless functions don't have time to wait longer
  headers: { "User-Agent": "RespireLYF-Pipeline/1.0" },
});

// ─── Seed queries for SerpAPI autocomplete ────────────────────────────────────
const SEED_QUERIES = [
  "asthma symptoms",
  "asthma triggers",
  "COPD breathing",
  "COPD flare up",
  "asthma worse",
  "inhaler not working",
  "breathing problems",
  "cough asthma",
  "asthma at night",
  "COPD exercise",
  "asthma food",
  "stress asthma",
];

// ─── RSS feeds ────────────────────────────────────────────────────────────────
const RSS_FEEDS: Array<{ url: string; source: TrendSource["name"] }> = [
  {
    // CDC Healthy Living / Respiratory RSS
    url: "https://tools.cdc.gov/api/v2/resources/media/132608.rss",
    source: "rss_cdc",
  },
  {
    // NHLBI press releases (updated URL)
    url: "https://www.nhlbi.nih.gov/news/press-releases",
    source: "rss_nhlbi",
  },
  {
    // American Lung Association blog RSS
    url: "https://www.lung.org/blog/rss.xml",
    source: "rss_nhlbi",
  },
];

// ─── Reddit subreddits ────────────────────────────────────────────────────────
const REDDIT_SUBS = ["Asthma", "COPD", "ChronicIllness"];

// ─── Seasonal context detection ───────────────────────────────────────────────
function detectSeasonalContext(): string | undefined {
  const month = new Date().getMonth() + 1; // 1–12
  if (month >= 3 && month <= 5)  return "allergy_season";
  if (month >= 6 && month <= 9)  return "wildfire_season";
  if (month >= 10 && month <= 11) return "cold_flu_season";
  if (month === 12 || month <= 2) return "winter";
  return undefined;
}

// ─── SerpAPI — Google Trends ──────────────────────────────────────────────────
async function scrapeGoogleTrends(run_id: string): Promise<TrendSignal[]> {
  const signals: TrendSignal[] = [];
  const seasonal = detectSeasonalContext();

  // Skip if no SerpAPI key — otherwise we hammer the endpoint with invalid calls
  // and eat the function's time budget before even reaching topic generation.
  if (!config.serpApi.key) {
    logger.warn("trend_scraper", "SERP_API_KEY not set — skipping Google Trends", { run_id });
    return signals;
  }

  for (const query of SEED_QUERIES) {
    try {
      const { data } = await axios.get("https://serpapi.com/search", {
        params: {
          engine: "google_trends",
          q: query,
          data_type: "RELATED_QUERIES",
          api_key: config.serpApi.key,
        },
        timeout: 10000,
      });

      const rising: string[] =
        data?.related_queries?.rising?.map((r: { query: string }) => r.query) ?? [];
      const top: string[] =
        data?.related_queries?.top?.map((r: { query: string }) => r.query) ?? [];

      for (const q of rising.slice(0, 3)) {
        signals.push({
          id: randomUUID(),
          raw_query: q,
          source: { name: "google_trends" },
          trend_direction: "rising",
          patient_intent_flag: isPatientIntent(q),
          seasonal_context_tag: seasonal,
          scraped_at: new Date().toISOString(),
          passed_gate: false,
        });
      }
      for (const q of top.slice(0, 2)) {
        signals.push({
          id: randomUUID(),
          raw_query: q,
          source: { name: "google_trends" },
          trend_direction: "stable",
          patient_intent_flag: isPatientIntent(q),
          seasonal_context_tag: seasonal,
          scraped_at: new Date().toISOString(),
          passed_gate: false,
        });
      }
    } catch (err) {
      logger.warn("trend_scraper", `Google Trends failed for query: ${query}`, {
        run_id,
        data: { error: String(err) },
      });
    }
  }

  logger.info("trend_scraper", `Google Trends: ${signals.length} signals`, { run_id });
  return signals;
}

// ─── Reddit ───────────────────────────────────────────────────────────────────
let redditAccessToken: string | null = null;
let redditTokenExpiry = 0;

async function getRedditToken(): Promise<string> {
  if (redditAccessToken && Date.now() < redditTokenExpiry) {
    return redditAccessToken;
  }
  const { data } = await axios.post(
    "https://www.reddit.com/api/v1/access_token",
    "grant_type=client_credentials",
    {
      auth: {
        username: config.reddit.clientId,
        password: config.reddit.clientSecret,
      },
      headers: {
        "User-Agent": config.reddit.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  redditAccessToken = data.access_token;
  redditTokenExpiry = Date.now() + data.expires_in * 1000 - 60000;
  return redditAccessToken!;
}

async function scrapeReddit(run_id: string): Promise<TrendSignal[]> {
  const signals: TrendSignal[] = [];
  const seasonal = detectSeasonalContext();

  // Skip if Reddit creds missing — auth call will just 401 otherwise and
  // chew into the function's time budget.
  if (!config.reddit.clientId || !config.reddit.clientSecret) {
    logger.warn("trend_scraper", "Reddit credentials not set — skipping Reddit", { run_id });
    return signals;
  }

  try {
    const token = await getRedditToken();

    for (const sub of REDDIT_SUBS) {
      const { data } = await axios.get(
        `https://oauth.reddit.com/r/${sub}/top.json?t=week&limit=10`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": config.reddit.userAgent,
          },
          timeout: 10000,
        }
      );

      const posts = data?.data?.children ?? [];
      for (const post of posts) {
        const title: string = post.data?.title ?? "";
        if (!title) continue;

        signals.push({
          id: randomUUID(),
          raw_query: title,
          source: {
            name: "reddit",
            url: `https://reddit.com/r/${sub}/comments/${post.data.id}`,
          },
          trend_direction: "stable",
          patient_intent_flag: isPatientIntent(title),
          seasonal_context_tag: seasonal,
          scraped_at: new Date().toISOString(),
          passed_gate: false,
        });
      }
    }
  } catch (err) {
    logger.warn("trend_scraper", "Reddit scrape failed", {
      run_id,
      data: { error: String(err) },
    });
  }

  logger.info("trend_scraper", `Reddit: ${signals.length} signals`, { run_id });
  return signals;
}

// ─── RSS Feeds ────────────────────────────────────────────────────────────────
async function scrapeRSSFeeds(run_id: string): Promise<TrendSignal[]> {
  const signals: TrendSignal[] = [];
  const seasonal = detectSeasonalContext();
  const ONE_WEEK_AGO = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      const recent = parsed.items.filter(
        (item) => item.pubDate && new Date(item.pubDate).getTime() > ONE_WEEK_AGO
      );

      for (const item of recent.slice(0, 5)) {
        const query = item.title ?? item.summary ?? "";
        if (!query) continue;

        // Only include items that are asthma/COPD/respiratory relevant
        if (!isRespiratoryRelevant(query)) continue;

        signals.push({
          id: randomUUID(),
          raw_query: query,
          source: { name: feed.source, url: item.link },
          trend_direction: "stable",
          patient_intent_flag: false, // RSS is institutional, not patient searches
          seasonal_context_tag: seasonal,
          scraped_at: new Date().toISOString(),
          passed_gate: false,
        });
      }
    } catch (err) {
      logger.warn("trend_scraper", `RSS feed failed: ${feed.url}`, {
        run_id,
        data: { error: String(err) },
      });
    }
  }

  logger.info("trend_scraper", `RSS: ${signals.length} signals`, { run_id });
  return signals;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const PATIENT_INTENT_KEYWORDS = [
  "why", "how", "what", "does", "can", "help", "worse", "better",
  "treatment", "symptoms", "triggers", "cause", "relief", "manage",
  "home", "natural", "diet", "food", "sleep", "exercise", "weather",
  "stress", "cough", "breathing", "inhaler", "flare",
];

function isPatientIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return PATIENT_INTENT_KEYWORDS.some((kw) => lower.includes(kw));
}

const RESPIRATORY_KEYWORDS = [
  "asthma", "copd", "respiratory", "lung", "breathing", "inhaler",
  "bronchial", "airway", "cough", "wheeze", "dyspnea", "spirometry",
];

function isRespiratoryRelevant(text: string): boolean {
  const lower = text.toLowerCase();
  return RESPIRATORY_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── Main export ──────────────────────────────────────────────────────────────
// Wrap any scraper with an overall timeout so a single slow external API
// cannot stall the whole serverless invocation.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export async function runTrendScraper(run_id: string): Promise<TrendSignal[]> {
  logger.info("trend_scraper", "Starting all sources", { run_id });

  const [googleSignals, redditSignals, rssSignals] = await Promise.allSettled([
    withTimeout(scrapeGoogleTrends(run_id), 25_000, "Google Trends"),
    withTimeout(scrapeReddit(run_id),       15_000, "Reddit"),
    withTimeout(scrapeRSSFeeds(run_id),     20_000, "RSS feeds"),
  ]);

  const all: TrendSignal[] = [
    ...(googleSignals.status === "fulfilled" ? googleSignals.value : []),
    ...(redditSignals.status === "fulfilled" ? redditSignals.value : []),
    ...(rssSignals.status === "fulfilled"    ? rssSignals.value    : []),
  ];

  // Deduplicate by normalised query
  const seen = new Set<string>();
  const unique = all.filter((s) => {
    const key = s.raw_query.toLowerCase().trim().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  logger.info("trend_scraper", `Total unique signals: ${unique.length}`, { run_id });
  return unique;
}
