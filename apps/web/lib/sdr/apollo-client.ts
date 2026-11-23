/**
 * Apollo.io REST client for the SDR domain (F1-004).
 *
 * People search + organization enrichment via Apollo's public REST API. This is
 * the ONLY third-party sourcing surface for the feature: per
 * ceo_briefing.data_findings[2] and the liability_assessor, there is NO
 * LinkedIn scraping anywhere — every person/company field here comes from
 * Apollo's official API.
 *
 * Auth: APOLLO_API_KEY (server-only, read from process.env — never hardcoded).
 * When the key is absent (local/dev/preview without secrets) the client degrades
 * gracefully to empty results and logs a structured warning rather than throwing,
 * so the cron route and campaign-save path stay non-fatal.
 */

const APOLLO_BASE_URL = process.env.APOLLO_BASE_URL ?? "https://api.apollo.io/api/v1";

/** Campaign-level people filters, persisted as sdr_campaigns.apollo_filters. */
export type ApolloPeopleFilters = {
  personTitles?: string[];
  personSeniorities?: string[];
  organizationDomains?: string[];
  organizationIndustryTagIds?: string[];
  organizationNumEmployeesRanges?: string[];
  organizationLocations?: string[];
  personLocations?: string[];
  keywords?: string;
};

/** Raw organization fields Apollo returns inline on a person record. */
export type ApolloOrganization = {
  id?: string;
  name?: string;
  websiteUrl?: string | null;
  primaryDomain?: string | null;
  foundedYear?: number | null;
  estimatedNumEmployees?: number | null;
  annualRevenue?: number | null;
  latestFundingStage?: string | null;
  latestFundingRoundDate?: string | null;
  totalFunding?: number | null;
  jobPostingsCount?: number | null;
  industry?: string | null;
  blogUrl?: string | null;
  newsUrl?: string | null;
  intentStrength?: string | null;
  intentTopic?: string | null;
};

/** A person normalized out of Apollo's search/enrich payloads. */
export type ApolloPerson = {
  apolloId: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  companyName: string | null;
  companyDomain: string | null;
  countryCode: string | null;
  region: string | null;
  organization: ApolloOrganization;
};

type ApolloSearchResult = {
  people: ApolloPerson[];
  totalEntries: number;
  page: number;
  perPage: number;
};

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.apollo-client", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function apolloApiKey(): string | null {
  const key = process.env.APOLLO_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Derive a bare domain from an Apollo website_url or primary_domain field. */
export function domainFromWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  try {
    const withScheme = cleaned.includes("://") ? cleaned : `https://${cleaned}`;
    const host = new URL(withScheme).hostname;
    return host.replace(/^www\./, "") || null;
  } catch {
    return cleaned.replace(/^www\./, "").replace(/\/.*$/, "") || null;
  }
}

function normalizeOrganization(raw: Record<string, unknown> | null | undefined): ApolloOrganization {
  const org = raw ?? {};
  const website = toStr(org.website_url) ?? toStr(org.primary_domain);
  return {
    id: toStr(org.id) ?? undefined,
    name: toStr(org.name) ?? undefined,
    websiteUrl: toStr(org.website_url),
    primaryDomain: domainFromWebsite(website),
    foundedYear: toNumber(org.founded_year),
    estimatedNumEmployees: toNumber(org.estimated_num_employees),
    annualRevenue: toNumber(org.annual_revenue ?? org.organization_revenue),
    latestFundingStage: toStr(org.latest_funding_stage),
    latestFundingRoundDate: toStr(org.latest_funding_round_date),
    totalFunding: toNumber(org.total_funding),
    jobPostingsCount: toNumber(org.job_postings_count ?? org.num_job_postings),
    industry: toStr(org.industry),
    blogUrl: toStr(org.blog_url),
    newsUrl: toStr(org.news_url),
    intentStrength: toStr(org.intent_strength),
    intentTopic: toStr(org.intent_topic),
  };
}

function normalizePerson(raw: Record<string, unknown>): ApolloPerson | null {
  const apolloId = toStr(raw.id);
  if (!apolloId) return null;

  const orgRaw = (raw.organization ?? raw.account) as Record<string, unknown> | null | undefined;
  const organization = normalizeOrganization(orgRaw);

  const firstName = toStr(raw.first_name);
  const lastName = toStr(raw.last_name);
  const name =
    toStr(raw.name) ?? ([firstName, lastName].filter(Boolean).join(" ").trim() || "Unknown");

  return {
    apolloId,
    firstName,
    lastName,
    name,
    title: toStr(raw.title),
    email: toStr(raw.email),
    emailStatus: toStr(raw.email_status),
    companyName: toStr(raw.organization_name) ?? organization.name ?? null,
    companyDomain: domainFromWebsite(
      toStr(raw.organization_website) ?? organization.websiteUrl ?? organization.primaryDomain,
    ),
    countryCode: normalizeCountry(toStr(raw.country)),
    region: toStr(raw.state),
    organization,
  };
}

/** Map Apollo's free-text country to an ISO-2 code the geo-guard understands. */
function normalizeCountry(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "united states" || v === "usa" || v === "us" || v === "united states of america") {
    return "US";
  }
  if (v.length === 2) return v.toUpperCase();
  return raw.trim();
}

function buildSearchBody(filters: ApolloPeopleFilters, page: number, perPage: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    page,
    per_page: perPage,
  };
  if (filters.personTitles?.length) body.person_titles = filters.personTitles;
  if (filters.personSeniorities?.length) body.person_seniorities = filters.personSeniorities;
  if (filters.organizationDomains?.length) body.q_organization_domains = filters.organizationDomains.join("\n");
  if (filters.organizationIndustryTagIds?.length) body.organization_industry_tag_ids = filters.organizationIndustryTagIds;
  if (filters.organizationNumEmployeesRanges?.length) {
    body.organization_num_employees_ranges = filters.organizationNumEmployeesRanges;
  }
  if (filters.organizationLocations?.length) body.organization_locations = filters.organizationLocations;
  if (filters.personLocations?.length) body.person_locations = filters.personLocations;
  if (filters.keywords) body.q_keywords = filters.keywords;
  return body;
}

/**
 * Search Apollo's people database with the campaign's filters.
 *
 * Returns normalized people. On a missing API key or any transport/HTTP error
 * the call resolves to an empty result set (logged) so the sourcing loop never
 * crashes the cron run.
 */
export async function searchPeople(
  filters: ApolloPeopleFilters,
  page = 1,
  perPage = 25,
): Promise<ApolloSearchResult> {
  const empty: ApolloSearchResult = { people: [], totalEntries: 0, page, perPage };
  const apiKey = apolloApiKey();
  if (!apiKey) {
    log("warn", "apollo_api_key_missing", { page });
    return empty;
  }

  const boundedPerPage = Math.min(Math.max(perPage, 1), 100);
  let res: Response;
  try {
    res = await fetch(`${APOLLO_BASE_URL}/mixed_people/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(buildSearchBody(filters, page, boundedPerPage)),
      cache: "no-store",
    });
  } catch (err) {
    log("error", "apollo_search_transport_error", { error: String((err as Error).message) });
    return empty;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log("error", "apollo_search_http_error", { status: res.status, body: text.slice(0, 300) });
    return empty;
  }

  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    log("error", "apollo_search_parse_error", { error: String((err as Error).message) });
    return empty;
  }

  const rawPeople = Array.isArray(json.people) ? (json.people as Record<string, unknown>[]) : [];
  const people = rawPeople.map(normalizePerson).filter((p): p is ApolloPerson => p !== null);
  const pagination = (json.pagination ?? {}) as Record<string, unknown>;

  log("info", "apollo_search_ok", { page, returned: people.length });
  return {
    people,
    totalEntries: toNumber(pagination.total_entries) ?? people.length,
    page: toNumber(pagination.page) ?? page,
    perPage: boundedPerPage,
  };
}

/**
 * Enrich a single person (reveals a verified work email + organization fields)
 * via Apollo's people/match endpoint. Returns null when unavailable.
 */
export async function enrichPerson(params: {
  apolloId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
}): Promise<ApolloPerson | null> {
  const apiKey = apolloApiKey();
  if (!apiKey) {
    log("warn", "apollo_api_key_missing", { op: "enrich" });
    return null;
  }

  const body: Record<string, unknown> = { reveal_personal_emails: false };
  if (params.apolloId) body.id = params.apolloId;
  if (params.email) body.email = params.email;
  if (params.firstName) body.first_name = params.firstName;
  if (params.lastName) body.last_name = params.lastName;
  if (params.domain) body.domain = params.domain;

  try {
    const res = await fetch(`${APOLLO_BASE_URL}/people/match`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      log("error", "apollo_enrich_http_error", { status: res.status });
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    const person = json.person as Record<string, unknown> | undefined;
    return person ? normalizePerson(person) : null;
  } catch (err) {
    log("error", "apollo_enrich_transport_error", { error: String((err as Error).message) });
    return null;
  }
}
