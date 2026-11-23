/**
 * Trigger-signal enrichment for sourced prospects (F1-004).
 *
 * Attaches the buying-trigger signals named in ceo_briefing.key_features[0]
 * (funding / hiring-surge / leadership-change) plus new-office, generic
 * news-mention, and Apollo intent to sdr_prospect_signals. Two sources, both
 * official — NO LinkedIn scraping (data_findings[2], liability_assessor):
 *
 *   1. Structured fields already on the Apollo organization payload
 *      (latest funding round, open-role count, buyer-intent strength).
 *   2. An OPTIONAL company-news endpoint (SDR_NEWS_API_URL) whose headlines are
 *      keyword-classified into trigger types. Absent config → source skipped.
 *
 * Writes go through the substrate pg pool (@/lib/db buildDb) with parameterized
 * $1/$2 queries. The sdr_prospect_signals table is declared in
 * packages/db/company/sdr.ts.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";
import type { ApolloPerson } from "@/lib/sdr/apollo-client";

export const SIGNAL_TYPES = [
  "funding",
  "hiring_surge",
  "leadership_change",
  "new_office",
  "news_mention",
  "apollo_intent",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export type ProspectSignal = {
  type: SignalType;
  headline: string;
  sourceUrl: string | null;
  observedAt: string;
  weight: number;
};

export type SignalRecord = ProspectSignal & {
  id: string;
  prospectId: string;
};

type SignalRow = {
  id: string;
  prospect_id: string;
  type: string;
  headline: string;
  source_url: string | null;
  observed_at: string | Date;
  weight: number;
};

/** Default signal weights (higher = stronger buying intent). */
const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  funding: 5,
  leadership_change: 4,
  hiring_surge: 3,
  new_office: 2,
  apollo_intent: 3,
  news_mention: 1,
};

const FUNDING_RECENCY_DAYS = 365;
const HIRING_SURGE_MIN_POSTINGS = 8;

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.signal-enrichment", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function coerceSignalType(raw: string): SignalType {
  return (SIGNAL_TYPES as readonly string[]).includes(raw) ? (raw as SignalType) : "news_mention";
}

function daysSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((nowMs - t) / 86_400_000);
}

function toRecord(row: SignalRow): SignalRecord {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    type: coerceSignalType(row.type),
    headline: row.headline,
    sourceUrl: row.source_url,
    observedAt:
      row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at),
    weight: Number(row.weight),
  };
}

/**
 * Derive trigger signals from the structured Apollo organization payload. Pure
 * function (no I/O) so it is unit-testable and deterministic.
 */
export function deriveApolloSignals(person: ApolloPerson, nowMs: number): ProspectSignal[] {
  const org = person.organization;
  const company = person.companyName ?? org.name ?? "the company";
  const signals: ProspectSignal[] = [];
  const nowIso = new Date(nowMs).toISOString();

  // Funding: a recent round or a known late stage with total raised.
  const fundingAgeDays = daysSince(org.latestFundingRoundDate, nowMs);
  if (
    (fundingAgeDays !== null && fundingAgeDays <= FUNDING_RECENCY_DAYS) ||
    (org.latestFundingStage && org.totalFunding && org.totalFunding > 0)
  ) {
    const stage = org.latestFundingStage ? ` (${org.latestFundingStage})` : "";
    const raised =
      org.totalFunding && org.totalFunding > 0
        ? ` — $${(org.totalFunding / 1_000_000).toFixed(1)}M total raised`
        : "";
    signals.push({
      type: "funding",
      headline: `${company} recently raised funding${stage}${raised}`,
      sourceUrl: org.blogUrl ?? org.websiteUrl ?? null,
      observedAt: org.latestFundingRoundDate ?? nowIso,
      weight: SIGNAL_WEIGHTS.funding,
    });
  }

  // Hiring surge: many concurrently open roles.
  if (org.jobPostingsCount !== null && org.jobPostingsCount !== undefined && org.jobPostingsCount >= HIRING_SURGE_MIN_POSTINGS) {
    signals.push({
      type: "hiring_surge",
      headline: `${company} has ${org.jobPostingsCount} open roles — active hiring surge`,
      sourceUrl: org.websiteUrl ?? null,
      observedAt: nowIso,
      weight: SIGNAL_WEIGHTS.hiring_surge,
    });
  }

  // Apollo buyer-intent score.
  if (org.intentStrength && org.intentStrength.toLowerCase() !== "none") {
    const topic = org.intentTopic ? ` on "${org.intentTopic}"` : "";
    signals.push({
      type: "apollo_intent",
      headline: `${company} shows ${org.intentStrength} buyer intent${topic}`,
      sourceUrl: org.websiteUrl ?? null,
      observedAt: nowIso,
      weight: SIGNAL_WEIGHTS.apollo_intent,
    });
  }

  return signals;
}

const NEWS_KEYWORDS: Array<{ type: SignalType; patterns: RegExp }> = [
  { type: "funding", patterns: /\b(raises?|raised|funding|series\s+[a-f]|seed round|venture|investment)\b/i },
  { type: "leadership_change", patterns: /\b(appoints?|appointed|names?\s+new|hires?\s+(ceo|cfo|cto|cro|vp)|promoted?|new chief|steps down|joins as)\b/i },
  { type: "hiring_surge", patterns: /\b(hiring|expands? team|headcount|adds?\s+\d+\s+(jobs|roles|employees))\b/i },
  { type: "new_office", patterns: /\b(opens?\s+(a\s+)?(new\s+)?office|new headquarters|expands? to|launches? in|new location)\b/i },
];

function classifyHeadline(headline: string): SignalType {
  for (const entry of NEWS_KEYWORDS) {
    if (entry.patterns.test(headline)) return entry.type;
  }
  return "news_mention";
}

/**
 * Fetch recent company-news headlines from the optional SDR_NEWS_API_URL and
 * classify each into a trigger type. Returns [] when the source is unconfigured
 * or errors — never throws into the sourcing loop.
 */
export async function fetchNewsSignals(domain: string | null, nowMs: number): Promise<ProspectSignal[]> {
  const base = process.env.SDR_NEWS_API_URL;
  if (!base || !domain) return [];

  const apiKey = process.env.SDR_NEWS_API_KEY ?? "";
  const url = `${base}${base.includes("?") ? "&" : "?"}domain=${encodeURIComponent(domain)}`;

  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } : { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      log("warn", "news_http_error", { status: res.status, domain });
      return [];
    }
    const json = (await res.json()) as Record<string, unknown>;
    const items = Array.isArray(json.articles)
      ? (json.articles as Record<string, unknown>[])
      : Array.isArray(json.results)
        ? (json.results as Record<string, unknown>[])
        : [];

    const signals: ProspectSignal[] = [];
    for (const item of items.slice(0, 10)) {
      const headline = typeof item.title === "string" ? item.title.trim() : "";
      if (!headline) continue;
      const type = classifyHeadline(headline);
      const publishedAt =
        typeof item.published_at === "string"
          ? item.published_at
          : typeof item.publishedAt === "string"
            ? item.publishedAt
            : new Date(nowMs).toISOString();
      signals.push({
        type,
        headline,
        sourceUrl: typeof item.url === "string" ? item.url : null,
        observedAt: publishedAt,
        weight: SIGNAL_WEIGHTS[type],
      });
    }
    return signals;
  } catch (err) {
    log("error", "news_transport_error", { domain, error: String((err as Error).message) });
    return [];
  }
}

function dedupeSignals(signals: ProspectSignal[]): ProspectSignal[] {
  const seen = new Set<string>();
  const out: ProspectSignal[] = [];
  for (const s of signals) {
    const key = `${s.type}::${s.headline.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Enrich one prospect: derive Apollo signals + fetch/classify news signals,
 * dedupe, and persist. Idempotent — the (prospect_id, type, headline) unique
 * index means re-runs skip existing rows. Returns the number of NEW signals.
 */
export async function enrichProspectSignals(params: {
  organizationId: string;
  prospectId: string;
  person: ApolloPerson;
  nowMs: number;
}): Promise<number> {
  const { organizationId, prospectId, person, nowMs } = params;

  const apolloSignals = deriveApolloSignals(person, nowMs);
  const newsSignals = await fetchNewsSignals(person.companyDomain, nowMs);
  const signals = dedupeSignals([...apolloSignals, ...newsSignals]);

  if (signals.length === 0) {
    log("info", "no_signals_derived", { prospectId });
    return 0;
  }

  const db = buildDb();
  let inserted = 0;
  for (const s of signals) {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO sdr_prospect_signals
         (id, organization_id, prospect_id, type, headline, source_url, observed_at, weight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (prospect_id, type, headline) DO NOTHING
       RETURNING id`,
      randomUUID(),
      organizationId,
      prospectId,
      s.type,
      s.headline,
      s.sourceUrl,
      s.observedAt,
      s.weight,
    );
    if (rows.length > 0) inserted += 1;
  }

  log("info", "signals_persisted", { prospectId, derived: signals.length, inserted });
  return inserted;
}

/** Load a prospect's signal timeline, newest first. */
export async function listProspectSignals(
  organizationId: string,
  prospectId: string,
): Promise<SignalRecord[]> {
  const db = buildDb();
  const rows = await db.query<SignalRow>(
    `SELECT id, prospect_id, type, headline, source_url, observed_at, weight
       FROM sdr_prospect_signals
      WHERE organization_id = $1 AND prospect_id = $2
      ORDER BY observed_at DESC, created_at DESC`,
    organizationId,
    prospectId,
  );
  return rows.map(toRecord);
}

/** Load signals for many prospects at once (list page chips). */
export async function listSignalsForProspects(
  organizationId: string,
  prospectIds: string[],
): Promise<Map<string, SignalRecord[]>> {
  const result = new Map<string, SignalRecord[]>();
  if (prospectIds.length === 0) return result;

  const db = buildDb();
  const rows = await db.query<SignalRow>(
    `SELECT id, prospect_id, type, headline, source_url, observed_at, weight
       FROM sdr_prospect_signals
      WHERE organization_id = $1 AND prospect_id = ANY($2::uuid[])
      ORDER BY observed_at DESC, created_at DESC`,
    organizationId,
    prospectIds,
  );

  for (const row of rows) {
    const rec = toRecord(row);
    const list = result.get(rec.prospectId) ?? [];
    list.push(rec);
    result.set(rec.prospectId, list);
  }
  return result;
}
