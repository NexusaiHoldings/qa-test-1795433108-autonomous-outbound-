/**
 * Prospect sourcing orchestrator (F1-004).
 *
 * The daily (and immediately-on-campaign-save) loop that turns a campaign's
 * Apollo filters into fresh sdr_prospects rows:
 *
 *   1. Pull people from Apollo (apps/web/lib/sdr/apollo-client).
 *   2. Drop anyone on the org's sdr_suppressions ledger OR failing the US-only
 *      geo-guard (apps/web/lib/sdr/{suppression,geo-guard}).
 *   3. Dedupe on email (within the batch AND against existing rows).
 *   4. Store up to campaign.daily_target NEW prospects in sdr_prospects.
 *   5. Attach trigger signals via apps/web/lib/sdr/signal-enrichment and
 *      recompute each prospect's fit score.
 *
 * Tenant-scoped by organization_id throughout. Raw parameterized SQL via the
 * substrate pg pool (@/lib/db). NO LinkedIn scraping anywhere.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";
import { searchPeople, type ApolloPeopleFilters, type ApolloPerson } from "@/lib/sdr/apollo-client";
import { listSuppressions, type SuppressionRecord } from "@/lib/sdr/suppression";
import { isSendable } from "@/lib/sdr/geo-guard";
import { enrichProspectSignals, listProspectSignals } from "@/lib/sdr/signal-enrichment";

export const PROSPECT_STATUSES = [
  "sourced",
  "sequenced",
  "contacted",
  "replied",
  "meeting_booked",
  "closed",
  "suppressed",
] as const;

export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export type ProspectRecord = {
  id: string;
  organizationId: string;
  campaignId: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  email: string;
  companyName: string | null;
  companyDomain: string | null;
  title: string | null;
  countryCode: string | null;
  region: string | null;
  fitScore: number;
  sourceExternalId: string | null;
  status: ProspectStatus;
  lastContactedAt: string | null;
  createdAt: string;
};

type ProspectRow = {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string;
  company_name: string | null;
  company_domain: string | null;
  title: string | null;
  country_code: string | null;
  region: string | null;
  fit_score: number | string | null;
  source_external_id: string | null;
  status: string;
  last_contacted_at: string | Date | null;
  created_at: string | Date;
};

export type SdrCampaign = {
  id: string;
  organizationId: string;
  name: string;
  status: string;
  dailyTarget: number;
  apolloFilters: ApolloPeopleFilters;
};

export type CampaignSourcingResult = {
  campaignId: string;
  organizationId: string;
  scanned: number;
  sourced: number;
  skippedSuppressed: number;
  skippedGeo: number;
  skippedDuplicate: number;
  signalsAttached: number;
};

type CampaignRow = {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  daily_target: number | string | null;
  apollo_filters: unknown;
};

const MAX_PAGES = 8;

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.sourcing", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function parseFilters(raw: unknown): ApolloPeopleFilters {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ApolloPeopleFilters;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as ApolloPeopleFilters;
  return {};
}

function toCampaign(row: CampaignRow): SdrCampaign {
  const target = Number(row.daily_target ?? 25);
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    dailyTarget: Number.isFinite(target) && target > 0 ? Math.min(target, 500) : 25,
    apolloFilters: parseFilters(row.apollo_filters),
  };
}

function coerceStatus(raw: string): ProspectStatus {
  return (PROSPECT_STATUSES as readonly string[]).includes(raw)
    ? (raw as ProspectStatus)
    : "sourced";
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toProspect(row: ProspectRow): ProspectRecord {
  const name =
    row.full_name ??
    ([row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email);
  const fit = Number(row.fit_score ?? 0);
  return {
    id: row.id,
    organizationId: row.organization_id,
    campaignId: row.campaign_id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: name,
    email: row.email,
    companyName: row.company_name,
    companyDomain: row.company_domain,
    title: row.title,
    countryCode: row.country_code,
    region: row.region,
    fitScore: Number.isFinite(fit) ? fit : 0,
    sourceExternalId: row.source_external_id,
    status: coerceStatus(row.status),
    lastContactedAt: toIso(row.last_contacted_at),
    createdAt: toIso(row.created_at) ?? "",
  };
}

const PROSPECT_COLUMNS = `id, organization_id, campaign_id, first_name, last_name, full_name,
  email, company_name, company_domain, title, country_code, region, fit_score,
  source_external_id, status, last_contacted_at, created_at`;

/**
 * List prospects for the org with faceted filters (status, campaign, free-text
 * search over name/company/email). Newest-fit first.
 */
export async function listProspects(params: {
  organizationId: string;
  status?: string;
  campaignId?: string;
  search?: string;
  limit?: number;
}): Promise<ProspectRecord[]> {
  const db = buildDb();
  const clauses: string[] = ["organization_id = $1"];
  const values: unknown[] = [params.organizationId];

  if (params.status && (PROSPECT_STATUSES as readonly string[]).includes(params.status)) {
    values.push(params.status);
    clauses.push(`status = $${values.length}`);
  }
  if (params.campaignId) {
    values.push(params.campaignId);
    clauses.push(`campaign_id = $${values.length}`);
  }
  if (params.search && params.search.trim()) {
    values.push(`%${params.search.trim().toLowerCase()}%`);
    const idx = values.length;
    clauses.push(
      `(lower(full_name) LIKE $${idx} OR lower(company_name) LIKE $${idx} OR lower(email) LIKE $${idx} OR lower(title) LIKE $${idx})`,
    );
  }

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  values.push(limit);

  const rows = await db.query<ProspectRow>(
    `SELECT ${PROSPECT_COLUMNS}
       FROM sdr_prospects
      WHERE ${clauses.join(" AND ")}
      ORDER BY fit_score DESC, created_at DESC
      LIMIT $${values.length}`,
    ...values,
  );
  return rows.map(toProspect);
}

/** Load a single prospect, tenant-scoped. */
export async function getProspect(
  organizationId: string,
  prospectId: string,
): Promise<ProspectRecord | null> {
  const db = buildDb();
  const rows = await db.query<ProspectRow>(
    `SELECT ${PROSPECT_COLUMNS}
       FROM sdr_prospects
      WHERE organization_id = $1 AND id = $2
      LIMIT 1`,
    organizationId,
    prospectId,
  );
  return rows[0] ? toProspect(rows[0]) : null;
}

/** Distinct status → count map for the list-page facet counts. */
export async function prospectStatusCounts(
  organizationId: string,
): Promise<Record<string, number>> {
  const db = buildDb();
  const rows = await db.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count
       FROM sdr_prospects
      WHERE organization_id = $1
      GROUP BY status`,
    organizationId,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

/** Load one campaign by id, tenant-scoped. */
export async function getCampaign(
  organizationId: string,
  campaignId: string,
): Promise<SdrCampaign | null> {
  const db = buildDb();
  const rows = await db.query<CampaignRow>(
    `SELECT id, organization_id, name, status, daily_target, apollo_filters
       FROM sdr_campaigns
      WHERE organization_id = $1 AND id = $2
      LIMIT 1`,
    organizationId,
    campaignId,
  );
  return rows[0] ? toCampaign(rows[0]) : null;
}

/** Load every active campaign (optionally scoped to one org) that is due to source. */
export async function listActiveCampaigns(organizationId?: string): Promise<SdrCampaign[]> {
  const db = buildDb();
  const rows = organizationId
    ? await db.query<CampaignRow>(
        `SELECT id, organization_id, name, status, daily_target, apollo_filters
           FROM sdr_campaigns
          WHERE organization_id = $1 AND status = 'active'
          ORDER BY created_at ASC`,
        organizationId,
      )
    : await db.query<CampaignRow>(
        `SELECT id, organization_id, name, status, daily_target, apollo_filters
           FROM sdr_campaigns
          WHERE status = 'active'
          ORDER BY created_at ASC`,
      );
  return rows.map(toCampaign);
}

/** Emails already stored for this org — used to dedupe across sourcing runs. */
async function loadExistingEmails(organizationId: string): Promise<Set<string>> {
  const db = buildDb();
  const rows = await db.query<{ email: string }>(
    `SELECT lower(email) AS email FROM sdr_prospects WHERE organization_id = $1`,
    organizationId,
  );
  return new Set(rows.map((r) => r.email).filter(Boolean));
}

function computeFitScore(signalWeightSum: number, emailStatus: string | null): number {
  const verifiedBonus = emailStatus && emailStatus.toLowerCase() === "verified" ? 15 : 0;
  const score = 40 + signalWeightSum * 6 + verifiedBonus;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Insert one prospect (status 'sourced'), enrich its signals, and set its fit
 * score from the attached signal weights. Returns the number of signals added,
 * or null if the insert was a no-op (email collided with an existing row).
 */
async function insertAndEnrich(
  campaign: SdrCampaign,
  person: ApolloPerson,
  nowMs: number,
): Promise<number | null> {
  const db = buildDb();
  const prospectId = randomUUID();
  const email = (person.email ?? "").trim().toLowerCase();

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO sdr_prospects
       (id, organization_id, campaign_id, first_name, last_name, full_name, email,
        company_name, company_domain, title, country_code, region, fit_score,
        source, source_external_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'apollo', $14, 'sourced')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    prospectId,
    campaign.organizationId,
    campaign.id,
    person.firstName,
    person.lastName,
    person.name,
    email,
    person.companyName,
    person.companyDomain,
    person.title,
    person.countryCode,
    person.region,
    0,
    person.apolloId,
  );

  if (inserted.length === 0) {
    return null; // lost the race / duplicate email — skip.
  }

  const signalsAttached = await enrichProspectSignals({
    organizationId: campaign.organizationId,
    prospectId,
    person,
    nowMs,
  });

  const signals = await listProspectSignals(campaign.organizationId, prospectId);
  const weightSum = signals.reduce((sum, s) => sum + s.weight, 0);
  const fitScore = computeFitScore(weightSum, person.emailStatus);

  await db.execute(
    `UPDATE sdr_prospects SET fit_score = $1, updated_at = NOW() WHERE id = $2`,
    fitScore,
    prospectId,
  );

  return signalsAttached;
}

/**
 * Source new prospects for a single campaign. Pages Apollo until the daily
 * target is met or results run out, filtering suppressed/non-US/duplicate rows.
 */
export async function sourceProspectsForCampaign(
  campaign: SdrCampaign,
  nowMs: number,
): Promise<CampaignSourcingResult> {
  const result: CampaignSourcingResult = {
    campaignId: campaign.id,
    organizationId: campaign.organizationId,
    scanned: 0,
    sourced: 0,
    skippedSuppressed: 0,
    skippedGeo: 0,
    skippedDuplicate: 0,
    signalsAttached: 0,
  };

  const suppressions: SuppressionRecord[] = await listSuppressions(campaign.organizationId);
  const seenEmails = await loadExistingEmails(campaign.organizationId);
  const target = campaign.dailyTarget;

  for (let page = 1; page <= MAX_PAGES && result.sourced < target; page += 1) {
    const perPage = Math.min(Math.max(target * 2, 25), 100);
    const search = await searchPeople(campaign.apolloFilters, page, perPage);
    if (search.people.length === 0) break;

    for (const person of search.people) {
      if (result.sourced >= target) break;
      result.scanned += 1;

      const email = (person.email ?? "").trim().toLowerCase();

      // Geo-guard + suppression ledger (missing email counts as unsendable).
      const gate = isSendable({ email, countryCode: person.countryCode }, suppressions);
      if (!gate.sendable) {
        if (gate.reason === "non_us") result.skippedGeo += 1;
        else if (gate.reason === "suppressed_email" || gate.reason === "suppressed_domain") {
          result.skippedSuppressed += 1;
        } else {
          result.skippedDuplicate += 1; // missing email — unusable row
        }
        continue;
      }

      // Dedupe on email within the batch and against existing rows.
      if (seenEmails.has(email)) {
        result.skippedDuplicate += 1;
        continue;
      }
      seenEmails.add(email);

      const signalsAttached = await insertAndEnrich(campaign, person, nowMs);
      if (signalsAttached === null) {
        result.skippedDuplicate += 1;
        continue;
      }
      result.sourced += 1;
      result.signalsAttached += signalsAttached;
    }

    if (search.people.length < perPage) break; // last page reached
  }

  // Stamp the run so operators can see cadence.
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_campaigns SET last_sourced_at = NOW(), updated_at = NOW() WHERE id = $1`,
    campaign.id,
  );

  log("info", "campaign_sourced", { ...result });
  return result;
}

/**
 * Source every active campaign (optionally one org / one campaign). Used by the
 * daily cron and the immediate-on-save trigger.
 */
export async function sourceCampaigns(params: {
  organizationId?: string;
  campaignId?: string;
  nowMs: number;
}): Promise<CampaignSourcingResult[]> {
  const { organizationId, campaignId, nowMs } = params;

  let campaigns: SdrCampaign[];
  if (campaignId && organizationId) {
    const one = await getCampaign(organizationId, campaignId);
    campaigns = one ? [one] : [];
  } else {
    campaigns = await listActiveCampaigns(organizationId);
  }

  const results: CampaignSourcingResult[] = [];
  for (const campaign of campaigns) {
    try {
      results.push(await sourceProspectsForCampaign(campaign, nowMs));
    } catch (err) {
      log("error", "campaign_source_failed", {
        campaignId: campaign.id,
        error: String((err as Error).message),
      });
    }
  }
  return results;
}
