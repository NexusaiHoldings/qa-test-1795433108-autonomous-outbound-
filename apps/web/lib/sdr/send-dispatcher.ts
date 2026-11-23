/**
 * Founder mailbox send dispatcher + guardrails (F1-006).
 *
 * The beating heart of the 'send' verb. Called every 15 minutes by
 * /api/cron/sdr-dispatch-sends. For each connected, un-paused mailbox it:
 *   1. resets the daily counter on a new calendar day,
 *   2. pulls queued touches that are due (next_send_at <= now, sequence active),
 *   3. re-checks suppression + geo + segment approval at send time (state can
 *      change between queueing and sending),
 *   4. only sends inside the prospect's business hours (refined by the
 *      @nexus/notifications predict_send_time heuristic),
 *   5. verifies the recipient address via the verification API before touch 1,
 *   6. appends the CAN-SPAM footer + List-Unsubscribe headers,
 *   7. threads touches 2-3 as replies to touch 1,
 *   8. enforces the warmup ramp (20 → 40 → 80/day) and the per-day cap,
 *   9. records an sdr_send_events row and auto-pauses the mailbox on a hard
 *      bounce / complaint spike.
 *
 * Raw SQL via the substrate pg pool with parameterized queries only. Server-only.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";
import { listSuppressions, type SuppressionRecord } from "@/lib/sdr/suppression";
import { isSendable } from "@/lib/sdr/geo-guard";
import { createUnsubscribeToken } from "@/lib/sdr/unsubscribe-token";
import {
  buildCanSpamFooter,
  buildListUnsubscribeHeaders,
  appendTextFooter,
  appendHtmlFooter,
} from "@/lib/sdr/can-spam-footer";
import { checkDomainAuth, domainFromEmail, hasMxRecord, type DomainAuthResult } from "@/lib/sdr/dns-check";
import {
  buildRawMessage,
  sendGmailMessage,
  fetchGmailMessageMeta,
  refreshGmailAccessToken,
} from "@/lib/sdr/mailbox-gmail";
import { sendOutlookMessage, refreshOutlookAccessToken } from "@/lib/sdr/mailbox-outlook";

// ─────────────────────────────────────────────────────────────────────────────
// Warmup ramp + caps
// ─────────────────────────────────────────────────────────────────────────────

/** The warmup ramp from the objective: 20 → 40 → 80 sends/day, then steady. */
export const WARMUP_CAPS: readonly number[] = [20, 40, 80];

/** Days a stage must run before the next ramp step is offered. */
export const WARMUP_STAGE_DAYS = 7;

export const MAILBOX_PROVIDERS = ["gmail", "outlook"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const SEND_EVENTS = [
  "queued",
  "sent",
  "bounced_soft",
  "bounced_hard",
  "complaint",
  "opened_unreliable",
] as const;
export type SendEvent = (typeof SEND_EVENTS)[number];

/** Daily cap implied by a warmup stage (stage index clamps into WARMUP_CAPS). */
export function capForStage(stage: number): number {
  const idx = Math.max(0, Math.min(stage, WARMUP_CAPS.length - 1));
  return WARMUP_CAPS[idx];
}

export interface MailboxRecord {
  id: string;
  organizationId: string;
  provider: MailboxProvider;
  email: string;
  domain: string | null;
  connectedAccountRef: string | null;
  displayName: string | null;
  physicalAddress: string | null;
  status: string;
  warmupStage: number;
  dailyCap: number;
  sentToday: number;
  sentTodayDate: string | null;
  warmupStartedAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
  dnsCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MailboxRow {
  id: string;
  organization_id: string;
  provider: string;
  email: string;
  domain: string | null;
  connected_account_ref: string | null;
  display_name: string | null;
  physical_address: string | null;
  status: string;
  warmup_stage: number;
  daily_cap: number;
  sent_today: number;
  sent_today_date: string | Date | null;
  warmup_started_at: string | Date | null;
  paused_at: string | Date | null;
  pause_reason: string | null;
  spf_ok: boolean;
  dkim_ok: boolean;
  dmarc_ok: boolean;
  dns_checked_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toMailbox(row: MailboxRow): MailboxRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: (row.provider === "outlook" ? "outlook" : "gmail") as MailboxProvider,
    email: row.email,
    domain: row.domain,
    connectedAccountRef: row.connected_account_ref,
    displayName: row.display_name,
    physicalAddress: row.physical_address,
    status: row.status,
    warmupStage: Number(row.warmup_stage ?? 0),
    dailyCap: Number(row.daily_cap ?? capForStage(0)),
    sentToday: Number(row.sent_today ?? 0),
    sentTodayDate: iso(row.sent_today_date),
    warmupStartedAt: iso(row.warmup_started_at),
    pausedAt: iso(row.paused_at),
    pauseReason: row.pause_reason,
    spfOk: Boolean(row.spf_ok),
    dkimOk: Boolean(row.dkim_ok),
    dmarcOk: Boolean(row.dmarc_ok),
    dnsCheckedAt: iso(row.dns_checked_at),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  };
}

const MAILBOX_COLUMNS = `
  id, organization_id, provider, email, domain, connected_account_ref, display_name,
  physical_address, status, warmup_stage, daily_cap, sent_today, sent_today_date,
  warmup_started_at, paused_at, pause_reason, spf_ok, dkim_ok, dmarc_ok,
  dns_checked_at, created_at, updated_at`;

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.send-dispatcher", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mailbox data access (consumed by the /mailbox page + actions)
// ─────────────────────────────────────────────────────────────────────────────

export async function listMailboxes(organizationId: string): Promise<MailboxRecord[]> {
  const db = buildDb();
  const rows = await db.query<MailboxRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM sdr_mailboxes
      WHERE organization_id = $1 ORDER BY created_at ASC`,
    organizationId,
  );
  return rows.map(toMailbox);
}

export async function getPrimaryMailbox(organizationId: string): Promise<MailboxRecord | null> {
  const db = buildDb();
  const rows = await db.query<MailboxRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM sdr_mailboxes
      WHERE organization_id = $1
      ORDER BY (status = 'connected') DESC, created_at ASC
      LIMIT 1`,
    organizationId,
  );
  return rows[0] ? toMailbox(rows[0]) : null;
}

export interface DnsDetailNote {
  ok: boolean;
  record: string | null;
  note: string;
}

export interface MailboxDnsDetail {
  spf: DnsDetailNote;
  dkim: DnsDetailNote;
  dmarc: DnsDetailNote;
}

const EMPTY_NOTE: DnsDetailNote = { ok: false, record: null, note: "Not checked yet." };

/** Read the stored DNS check detail (for the /mailbox fix-it drawer). */
export async function getMailboxDnsDetail(
  organizationId: string,
  mailboxId: string,
): Promise<MailboxDnsDetail> {
  const db = buildDb();
  const rows = await db.query<{ dns_detail: unknown }>(
    `SELECT dns_detail FROM sdr_mailboxes WHERE organization_id = $1 AND id = $2`,
    organizationId,
    mailboxId,
  );
  const raw = rows[0]?.dns_detail;
  const parsed = (typeof raw === "string" ? safeParse(raw) : raw) as Partial<MailboxDnsDetail> | null;
  return {
    spf: parsed?.spf ?? EMPTY_NOTE,
    dkim: parsed?.dkim ?? EMPTY_NOTE,
    dmarc: parsed?.dmarc ?? EMPTY_NOTE,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function getMailboxById(
  organizationId: string,
  mailboxId: string,
): Promise<MailboxRecord | null> {
  const db = buildDb();
  const rows = await db.query<MailboxRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM sdr_mailboxes WHERE organization_id = $1 AND id = $2`,
    organizationId,
    mailboxId,
  );
  return rows[0] ? toMailbox(rows[0]) : null;
}

/**
 * Create or update the org's sending mailbox from a connected account. Idempotent
 * on (organization_id, lower(email)). Runs the DNS auth check on connect.
 */
export async function connectMailbox(params: {
  organizationId: string;
  provider: MailboxProvider;
  email: string;
  displayName?: string | null;
  connectedAccountRef?: string | null;
  physicalAddress?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: number | null;
}): Promise<MailboxRecord> {
  const email = params.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("A valid mailbox email is required");
  }
  const domain = domainFromEmail(email);
  const db = buildDb();

  const dns = await runDnsForDomain(domain);
  const id = randomUUID();
  const expiresAt =
    params.tokenExpiresAt && params.tokenExpiresAt > 0
      ? new Date(params.tokenExpiresAt).toISOString()
      : null;

  const rows = await db.query<MailboxRow>(
    `INSERT INTO sdr_mailboxes
       (id, organization_id, provider, email, domain, connected_account_ref, display_name,
        physical_address, status, warmup_stage, daily_cap, sent_today, sent_today_date,
        warmup_started_at, spf_ok, dkim_ok, dmarc_ok, dns_detail, dns_checked_at,
        access_token, refresh_token, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'connected', 0, $9, 0, CURRENT_DATE,
             NOW(), $10, $11, $12, $13::jsonb, NOW(), $14, $15, $16)
     ON CONFLICT (organization_id, lower(email)) DO UPDATE SET
       provider = EXCLUDED.provider,
       connected_account_ref = COALESCE(EXCLUDED.connected_account_ref, sdr_mailboxes.connected_account_ref),
       display_name = COALESCE(EXCLUDED.display_name, sdr_mailboxes.display_name),
       physical_address = COALESCE(EXCLUDED.physical_address, sdr_mailboxes.physical_address),
       status = 'connected',
       paused_at = NULL,
       pause_reason = NULL,
       spf_ok = EXCLUDED.spf_ok,
       dkim_ok = EXCLUDED.dkim_ok,
       dmarc_ok = EXCLUDED.dmarc_ok,
       dns_detail = EXCLUDED.dns_detail,
       dns_checked_at = NOW(),
       access_token = COALESCE(EXCLUDED.access_token, sdr_mailboxes.access_token),
       refresh_token = COALESCE(EXCLUDED.refresh_token, sdr_mailboxes.refresh_token),
       token_expires_at = COALESCE(EXCLUDED.token_expires_at, sdr_mailboxes.token_expires_at),
       updated_at = NOW()
     RETURNING ${MAILBOX_COLUMNS}`,
    id,
    params.organizationId,
    params.provider,
    email,
    domain,
    params.connectedAccountRef ?? null,
    params.displayName ?? null,
    params.physicalAddress ?? null,
    capForStage(0),
    dns.spfOk,
    dns.dkimOk,
    dns.dmarcOk,
    JSON.stringify({ spf: dns.spf, dkim: dns.dkim, dmarc: dns.dmarc }),
    params.accessToken ?? null,
    params.refreshToken ?? null,
    expiresAt,
  );

  log("info", "mailbox_connected", {
    organizationId: params.organizationId,
    provider: params.provider,
    domain,
    spfOk: dns.spfOk,
    dkimOk: dns.dkimOk,
    dmarcOk: dns.dmarcOk,
  });
  return toMailbox(rows[0]);
}

async function runDnsForDomain(domain: string): Promise<DomainAuthResult> {
  try {
    return await checkDomainAuth(domain);
  } catch (err) {
    log("warn", "dns_check_failed", { domain, error: String((err as Error).message) });
    return {
      domain,
      spf: { ok: false, record: null, note: "DNS lookup failed." },
      dkim: { ok: false, record: null, note: "DNS lookup failed." },
      dmarc: { ok: false, record: null, note: "DNS lookup failed." },
      spfOk: false,
      dkimOk: false,
      dmarcOk: false,
      allOk: false,
      checkedAt: new Date().toISOString(),
    };
  }
}

/** Re-run SPF/DKIM/DMARC for a connected mailbox (fix-it drawer). */
export async function recheckMailboxDns(
  organizationId: string,
  mailboxId: string,
): Promise<DomainAuthResult | null> {
  const mailbox = await getMailboxById(organizationId, mailboxId);
  if (!mailbox) return null;
  const domain = mailbox.domain || domainFromEmail(mailbox.email);
  const dns = await runDnsForDomain(domain);
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_mailboxes
        SET spf_ok = $3, dkim_ok = $4, dmarc_ok = $5, dns_detail = $6::jsonb,
            dns_checked_at = NOW(), updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    organizationId,
    mailboxId,
    dns.spfOk,
    dns.dkimOk,
    dns.dmarcOk,
    JSON.stringify({ spf: dns.spf, dkim: dns.dkim, dmarc: dns.dmarc }),
  );
  return dns;
}

export async function pauseMailbox(
  organizationId: string,
  mailboxId: string,
  reason: string,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_mailboxes
        SET status = 'paused', paused_at = NOW(), pause_reason = $3, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    organizationId,
    mailboxId,
    reason.slice(0, 500),
  );
  log("warn", "mailbox_paused", { organizationId, mailboxId, reason });
}

export async function resumeMailbox(organizationId: string, mailboxId: string): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_mailboxes
        SET status = 'connected', paused_at = NULL, pause_reason = NULL, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    organizationId,
    mailboxId,
  );
  log("info", "mailbox_resumed", { organizationId, mailboxId });
}

/**
 * Advance the warmup ramp one step. Caller (the dispatcher or the operator) only
 * reaches the next cap after WARMUP_STAGE_DAYS and once DNS auth is green.
 */
export async function advanceWarmup(organizationId: string, mailboxId: string): Promise<MailboxRecord | null> {
  const mailbox = await getMailboxById(organizationId, mailboxId);
  if (!mailbox) return null;
  const nextStage = Math.min(mailbox.warmupStage + 1, WARMUP_CAPS.length - 1);
  const db = buildDb();
  const rows = await db.query<MailboxRow>(
    `UPDATE sdr_mailboxes
        SET warmup_stage = $3, daily_cap = $4, warmup_started_at = NOW(), updated_at = NOW()
      WHERE organization_id = $1 AND id = $2
      RETURNING ${MAILBOX_COLUMNS}`,
    organizationId,
    mailboxId,
    nextStage,
    capForStage(nextStage),
  );
  return rows[0] ? toMailbox(rows[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deliverability health (the /mailbox gauge)
// ─────────────────────────────────────────────────────────────────────────────

export interface MailboxHealth {
  score: number;
  dnsScore: number;
  reputationScore: number;
  warmupScore: number;
  sentToday: number;
  dailyCap: number;
  bounceRate: number;
  complaintRate: number;
  totalSent30d: number;
}

/**
 * Compute a 0-100 sending-health score from DNS auth, bounce/complaint rates
 * over the trailing 30 days, and warmup progress. Drives the circular gauge.
 */
export async function computeMailboxHealth(
  organizationId: string,
  mailbox: MailboxRecord,
): Promise<MailboxHealth> {
  const db = buildDb();
  const stats = await db.query<{
    sent: string;
    bounced: string;
    complaints: string;
  }>(
    `SELECT
        COUNT(*) FILTER (WHERE event = 'sent')::text AS sent,
        COUNT(*) FILTER (WHERE event IN ('bounced_hard', 'bounced_soft'))::text AS bounced,
        COUNT(*) FILTER (WHERE event = 'complaint')::text AS complaints
       FROM sdr_send_events
      WHERE organization_id = $1 AND mailbox_id = $2
        AND occurred_at >= NOW() - INTERVAL '30 days'`,
    organizationId,
    mailbox.id,
  );
  const sent = Number(stats[0]?.sent ?? "0");
  const bounced = Number(stats[0]?.bounced ?? "0");
  const complaints = Number(stats[0]?.complaints ?? "0");

  const denom = Math.max(sent, 1);
  const bounceRate = bounced / denom;
  const complaintRate = complaints / denom;

  const dnsPoints = (mailbox.spfOk ? 14 : 0) + (mailbox.dkimOk ? 14 : 0) + (mailbox.dmarcOk ? 12 : 0); // 40
  const dnsScore = Math.round((dnsPoints / 40) * 100);

  // Reputation: start from 40, lose points for bounces/complaints (complaints hurt most).
  const reputationPoints = Math.max(0, 40 - bounceRate * 200 - complaintRate * 600);
  const reputationScore = Math.round((reputationPoints / 40) * 100);

  // Warmup contribution: later stages + established history score higher.
  const warmupPoints = Math.min(20, mailbox.warmupStage * 7 + Math.min(sent, 60) / 6);
  const warmupScore = Math.round((warmupPoints / 20) * 100);

  const score = Math.max(0, Math.min(100, Math.round(dnsPoints + reputationPoints + warmupPoints)));

  return {
    score,
    dnsScore,
    reputationScore,
    warmupScore,
    sentToday: mailbox.sentToday,
    dailyCap: mailbox.dailyCap,
    bounceRate,
    complaintRate,
    totalSent30d: sent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Business-hours gating + predict_send_time refinement
// ─────────────────────────────────────────────────────────────────────────────

/** Coarse US-state → IANA timezone map for business-hours gating. */
const REGION_TIMEZONES: Record<string, string> = {
  CA: "America/Los_Angeles",
  WA: "America/Los_Angeles",
  OR: "America/Los_Angeles",
  NV: "America/Los_Angeles",
  AZ: "America/Phoenix",
  CO: "America/Denver",
  UT: "America/Denver",
  NM: "America/Denver",
  TX: "America/Chicago",
  IL: "America/Chicago",
  MN: "America/Chicago",
  MO: "America/Chicago",
  WI: "America/Chicago",
  NY: "America/New_York",
  NJ: "America/New_York",
  MA: "America/New_York",
  PA: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  NC: "America/New_York",
  VA: "America/New_York",
};

const BUSINESS_HOUR_START = 9; // 9am local
const BUSINESS_HOUR_END = 17; // 5pm local
/** predict_send_time heuristic — mid-morning is the empirically best cold window. */
const OPTIMAL_SEND_HOUR = 10;

function timezoneFor(region: string | null | undefined): string {
  const key = (region ?? "").trim().toUpperCase();
  return REGION_TIMEZONES[key] ?? process.env.SDR_DEFAULT_TIMEZONE ?? "America/New_York";
}

interface LocalParts {
  weekday: number; // 0 = Sun … 6 = Sat
  hour: number;
}

function localParts(nowMs: number, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "12";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(hourStr);
  if (hour === 24) hour = 0; // some runtimes emit "24" for midnight
  return { weekday: weekdayMap[weekdayStr] ?? 1, hour };
}

export function isWithinBusinessHours(
  nowMs: number,
  region: string | null | undefined,
): boolean {
  const { weekday, hour } = localParts(nowMs, timezoneFor(region));
  if (weekday === 0 || weekday === 6) return false; // weekends
  return hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END;
}

/**
 * Refine the next send time toward the optimal mid-morning window within the
 * prospect's business hours — the local realization of
 * @nexus/notifications predict_send_time. Returns an ISO timestamp.
 */
export function refineNextSendAt(nowMs: number, region: string | null | undefined): string {
  const tz = timezoneFor(region);
  // Advance hour-by-hour (UTC) until we land on a weekday at the optimal local
  // hour. Bounded to one week so we always terminate.
  for (let i = 0; i <= 24 * 7; i += 1) {
    const candidate = nowMs + i * 3_600_000;
    const { weekday, hour } = localParts(candidate, tz);
    const isWeekday = weekday !== 0 && weekday !== 6;
    if (isWeekday && hour === OPTIMAL_SEND_HOUR) {
      return new Date(candidate).toISOString();
    }
  }
  return new Date(nowMs + 3_600_000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient verification (before touch 1)
// ─────────────────────────────────────────────────────────────────────────────

export type VerificationStatus = "deliverable" | "risky" | "undeliverable" | "unknown";

/**
 * Verify a recipient address before the first touch to protect deliverability.
 * Prefers an external verification API (SDR_EMAIL_VERIFICATION_URL); when none is
 * configured it falls back to an MX-record lookup so obviously-dead domains are
 * still caught. Never throws — a verification failure degrades to "unknown".
 */
export async function verifyRecipientAddress(email: string): Promise<VerificationStatus> {
  const endpoint = process.env.SDR_EMAIL_VERIFICATION_URL;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      url.searchParams.set("email", email);
      const apiKey = process.env.SDR_EMAIL_VERIFICATION_KEY;
      const res = await fetch(url.toString(), {
        headers: apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {},
      });
      if (res.ok) {
        const data = (await res.json()) as { status?: string; result?: string; deliverable?: boolean };
        const raw = (data.status || data.result || "").toLowerCase();
        if (raw.includes("undeliverable") || raw.includes("invalid") || data.deliverable === false) {
          return "undeliverable";
        }
        if (raw.includes("risky") || raw.includes("catch_all") || raw.includes("unknown")) {
          return "risky";
        }
        if (raw.includes("deliverable") || raw.includes("valid") || data.deliverable === true) {
          return "deliverable";
        }
        return "unknown";
      }
    } catch (err) {
      log("warn", "verification_api_failed", { error: String((err as Error).message) });
    }
  }

  // Fallback: MX lookup. A domain with no MX record cannot receive mail.
  const domain = domainFromEmail(email);
  const hasMx = await hasMxRecord(domain);
  return hasMx ? "deliverable" : "undeliverable";
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth token resolution + event recording
// ─────────────────────────────────────────────────────────────────────────────

interface TokenState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

/**
 * Resolve a usable access token for the mailbox. Uses the stored token when it
 * is still valid, otherwise refreshes it. Returns null when no credentials are
 * available (the connected-accounts scope gap) — the dispatcher treats that as
 * "cannot send yet" rather than an error.
 */
async function resolveAccessToken(mailbox: MailboxRecord): Promise<string | null> {
  const db = buildDb();
  const rows = await db.query<{
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: string | Date | null;
  }>(
    `SELECT access_token, refresh_token, token_expires_at
       FROM sdr_mailboxes WHERE organization_id = $1 AND id = $2`,
    mailbox.organizationId,
    mailbox.id,
  );
  const row = rows[0];
  const state: TokenState = {
    accessToken: row?.access_token ?? null,
    refreshToken: row?.refresh_token ?? null,
    expiresAt: row?.token_expires_at ? new Date(iso(row.token_expires_at) as string).getTime() : null,
  };

  const skewMs = 60_000;
  if (state.accessToken && (!state.expiresAt || state.expiresAt - Date.now() > skewMs)) {
    return state.accessToken;
  }

  const refreshed =
    mailbox.provider === "outlook"
      ? await refreshOutlookAccessToken(state.refreshToken)
      : await refreshGmailAccessToken(state.refreshToken);

  if (!refreshed) {
    // Last resort: an env-supplied token for single-tenant/dev operation.
    return process.env.SDR_FALLBACK_SEND_TOKEN ?? null;
  }

  await db.execute(
    `UPDATE sdr_mailboxes SET access_token = $3, token_expires_at = $4, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    mailbox.organizationId,
    mailbox.id,
    refreshed.accessToken,
    new Date(refreshed.expiresAt).toISOString(),
  );
  return refreshed.accessToken;
}

export async function recordSendEvent(params: {
  organizationId: string;
  mailboxId: string;
  messageId: string | null;
  event: SendEvent;
  providerPayload?: unknown;
}): Promise<void> {
  const db = buildDb();
  await db.execute(
    `INSERT INTO sdr_send_events (id, organization_id, message_id, mailbox_id, event, provider_payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    randomUUID(),
    params.organizationId,
    params.messageId,
    params.mailboxId,
    params.event,
    JSON.stringify(params.providerPayload ?? {}),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The dispatch loop
// ─────────────────────────────────────────────────────────────────────────────

interface DueMessageRow {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  prospect_id: string | null;
  sequence_id: string | null;
  touch_index: number;
  subject: string | null;
  body_text: string | null;
  prospect_email: string | null;
  prospect_name: string | null;
  country_code: string | null;
  region: string | null;
}

export interface DispatchSummary {
  mailboxes: number;
  sent: number;
  skipped: number;
  suppressed: number;
  failed: number;
  outOfHours: number;
  capReached: number;
  noCredentials: number;
}

/** Auto-pause thresholds — a reputation cliff must stop the mailbox immediately. */
const HARD_BOUNCE_PAUSE_RATE = 0.05;
const COMPLAINT_PAUSE_RATE = 0.003;

/**
 * Main entry — dispatch every due touch across every connected mailbox, honoring
 * the warmup cap, business hours, suppression/geo/approval re-checks, address
 * verification, CAN-SPAM footer, and reply threading.
 */
export async function dispatchDueSends(params: {
  nowMs: number;
  limit?: number;
  organizationId?: string;
}): Promise<DispatchSummary> {
  const nowMs = params.nowMs;
  const globalLimit = Math.min(Math.max(params.limit ?? 200, 1), 1000);
  const db = buildDb();

  const mailboxRows = params.organizationId
    ? await db.query<MailboxRow>(
        `SELECT ${MAILBOX_COLUMNS} FROM sdr_mailboxes
          WHERE organization_id = $1 AND status = 'connected' ORDER BY created_at ASC`,
        params.organizationId,
      )
    : await db.query<MailboxRow>(
        `SELECT ${MAILBOX_COLUMNS} FROM sdr_mailboxes WHERE status = 'connected' ORDER BY created_at ASC`,
      );

  const summary: DispatchSummary = {
    mailboxes: mailboxRows.length,
    sent: 0,
    skipped: 0,
    suppressed: 0,
    failed: 0,
    outOfHours: 0,
    capReached: 0,
    noCredentials: 0,
  };

  let remainingGlobal = globalLimit;

  for (const row of mailboxRows) {
    if (remainingGlobal <= 0) break;
    const mailbox = await resetDailyCounterIfNeeded(toMailbox(row), nowMs);
    const remainingForMailbox = mailbox.dailyCap - mailbox.sentToday;
    if (remainingForMailbox <= 0) {
      summary.capReached += 1;
      continue;
    }

    const suppressions = await listSuppressions(mailbox.organizationId);
    const batchLimit = Math.min(remainingForMailbox, remainingGlobal);
    const due = await loadDueMessages(mailbox.organizationId, nowMs, batchLimit);

    let sentThisMailbox = 0;
    for (const msg of due) {
      if (sentThisMailbox >= remainingForMailbox || remainingGlobal <= 0) break;

      let outcome: MessageOutcome;
      try {
        outcome = await dispatchOneMessage({ mailbox, msg, suppressions, nowMs });
      } catch (err) {
        outcome = "failed";
        log("error", "dispatch_message_error", { messageId: msg.id, error: String((err as Error).message) });
      }
      switch (outcome) {
        case "sent":
          summary.sent += 1;
          sentThisMailbox += 1;
          remainingGlobal -= 1;
          break;
        case "suppressed":
          summary.suppressed += 1;
          break;
        case "out_of_hours":
          summary.outOfHours += 1;
          break;
        case "no_credentials":
          summary.noCredentials += 1;
          break;
        case "failed":
          summary.failed += 1;
          break;
        default:
          summary.skipped += 1;
      }
      if (outcome === "no_credentials") break; // no point retrying the rest of this mailbox
    }

    await maybeAutoPause(mailbox);
  }

  log("info", "dispatch_complete", { ...summary });
  return summary;
}

async function resetDailyCounterIfNeeded(mailbox: MailboxRecord, nowMs: number): Promise<MailboxRecord> {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (mailbox.sentTodayDate && mailbox.sentTodayDate.slice(0, 10) === today) {
    return mailbox;
  }
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_mailboxes SET sent_today = 0, sent_today_date = $3::date, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    mailbox.organizationId,
    mailbox.id,
    today,
  );
  return { ...mailbox, sentToday: 0, sentTodayDate: today };
}

async function loadDueMessages(
  organizationId: string,
  nowMs: number,
  limit: number,
): Promise<DueMessageRow[]> {
  const db = buildDb();
  return db.query<DueMessageRow>(
    `SELECT m.id, m.organization_id, m.campaign_id, m.prospect_id, m.sequence_id,
            m.touch_index, m.subject, m.body_text,
            p.email AS prospect_email, p.full_name AS prospect_name,
            p.country_code, p.region
       FROM sdr_messages m
       JOIN sdr_sequences s ON s.id = m.sequence_id
       LEFT JOIN sdr_prospects p ON p.id = m.prospect_id
      WHERE m.organization_id = $1
        AND m.status = 'queued'
        AND m.direction = 'outbound'
        AND m.next_send_at IS NOT NULL
        AND m.next_send_at <= $2
        AND s.status = 'active'
      ORDER BY m.next_send_at ASC, m.touch_index ASC
      LIMIT $3`,
    organizationId,
    new Date(nowMs).toISOString(),
    limit,
  );
}

type MessageOutcome = "sent" | "suppressed" | "out_of_hours" | "no_credentials" | "failed" | "skipped";

async function dispatchOneMessage(args: {
  mailbox: MailboxRecord;
  msg: DueMessageRow;
  suppressions: SuppressionRecord[];
  nowMs: number;
}): Promise<MessageOutcome> {
  const { mailbox, msg, suppressions, nowMs } = args;
  const db = buildDb();
  const email = (msg.prospect_email ?? "").trim().toLowerCase();

  // (3) Re-check geo + suppression at send time.
  const sendable = isSendable({ email, countryCode: msg.country_code }, suppressions);
  if (!sendable.sendable) {
    await db.execute(
      `UPDATE sdr_messages SET status = 'cancelled', next_send_at = NULL, last_error = $3, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      mailbox.organizationId,
      msg.id,
      `blocked:${sendable.reason}`,
    );
    log("info", "send_blocked", { messageId: msg.id, reason: sendable.reason });
    return "suppressed";
  }

  // (4) Business-hours gate — refined toward the optimal window if out of hours.
  if (!isWithinBusinessHours(nowMs, msg.region)) {
    const nextAt = refineNextSendAt(nowMs, msg.region);
    await db.execute(
      `UPDATE sdr_messages SET next_send_at = $3, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      mailbox.organizationId,
      msg.id,
      nextAt,
    );
    return "out_of_hours";
  }

  // (5) Verify the recipient before the first touch.
  if (msg.touch_index === 0) {
    const verification = await verifyRecipientAddress(email);
    if (verification === "undeliverable") {
      await suppressUndeliverable(mailbox.organizationId, email, msg.id);
      await db.execute(
        `UPDATE sdr_messages SET status = 'cancelled', next_send_at = NULL, last_error = 'undeliverable', updated_at = NOW()
          WHERE organization_id = $1 AND id = $2`,
        mailbox.organizationId,
        msg.id,
      );
      await recordSendEvent({
        organizationId: mailbox.organizationId,
        mailboxId: mailbox.id,
        messageId: msg.id,
        event: "bounced_hard",
        providerPayload: { stage: "pre_send_verification", result: verification },
      });
      log("info", "verification_undeliverable", { messageId: msg.id });
      return "suppressed";
    }
  }

  // (6) Build the CAN-SPAM footer + List-Unsubscribe headers.
  const unsubscribeUrl = buildUnsubscribeUrl(mailbox.organizationId, email, msg.id);
  const footer = buildCanSpamFooter({
    physicalAddress: mailbox.physicalAddress || process.env.SDR_SENDER_ADDRESS || "",
    unsubscribeUrl,
    recipientName: msg.prospect_name,
  });
  const headers = buildListUnsubscribeHeaders(unsubscribeUrl, mailbox.email);
  const bodyText = appendTextFooter(msg.body_text ?? "", footer);
  const bodyHtml = appendHtmlFooter(textToHtml(msg.body_text ?? ""), footer);

  // (7) Threading — touches 2-3 reply to touch 1.
  const thread = msg.touch_index > 0 ? await loadThreadRefs(mailbox.organizationId, msg.sequence_id) : null;

  // Resolve the OAuth token.
  const accessToken = await resolveAccessToken(mailbox);
  if (!accessToken) {
    log("warn", "no_send_credentials", { mailboxId: mailbox.id });
    return "no_credentials";
  }

  const sendResult = await sendViaProvider({
    mailbox,
    accessToken,
    to: email,
    toName: msg.prospect_name,
    subject: threadedSubject(msg.subject ?? "", msg.touch_index),
    bodyText,
    bodyHtml,
    headers,
    thread,
  });

  if (!sendResult.ok) {
    await db.execute(
      `UPDATE sdr_messages SET last_error = $3, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      mailbox.organizationId,
      msg.id,
      (sendResult.error ?? "send_failed").slice(0, 500),
    );
    log("warn", "send_failed", { messageId: msg.id, error: sendResult.error });
    return "failed";
  }

  // (8/9) Persist the sent state, threading refs, counters, and the event.
  await db.execute(
    `UPDATE sdr_messages
        SET status = 'sent', sent_at = NOW(), provider_message_id = $3,
            thread_ref = $4, rfc822_message_id = $5, sent_mailbox_id = $6,
            last_error = NULL, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    mailbox.organizationId,
    msg.id,
    sendResult.providerMessageId,
    sendResult.threadRef,
    sendResult.rfc822MessageId,
    mailbox.id,
  );

  await db.execute(
    `UPDATE sdr_mailboxes SET sent_today = sent_today + 1, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    mailbox.organizationId,
    mailbox.id,
  );

  if (msg.prospect_id) {
    await db.execute(
      `UPDATE sdr_prospects SET last_contacted_at = NOW(), status = 'contacted', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      msg.prospect_id,
      mailbox.organizationId,
    );
  }

  await recordSendEvent({
    organizationId: mailbox.organizationId,
    mailboxId: mailbox.id,
    messageId: msg.id,
    event: "sent",
    providerPayload: {
      provider: mailbox.provider,
      providerMessageId: sendResult.providerMessageId,
      threadRef: sendResult.threadRef,
      touchIndex: msg.touch_index,
    },
  });

  await maybeCompleteSequence(mailbox.organizationId, msg.sequence_id);

  log("info", "send_ok", {
    messageId: msg.id,
    mailboxId: mailbox.id,
    touchIndex: msg.touch_index,
    provider: mailbox.provider,
  });
  return "sent";
}

interface ProviderSendOutcome {
  ok: boolean;
  providerMessageId: string | null;
  threadRef: string | null;
  rfc822MessageId: string | null;
  error?: string;
}

async function sendViaProvider(args: {
  mailbox: MailboxRecord;
  accessToken: string;
  to: string;
  toName: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  headers: Record<string, string>;
  thread: { threadRef: string | null; rfc822MessageId: string | null } | null;
}): Promise<ProviderSendOutcome> {
  const { mailbox } = args;

  if (mailbox.provider === "outlook") {
    const res = await sendOutlookMessage({
      accessToken: args.accessToken,
      to: args.to,
      toName: args.toName,
      subject: args.subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml,
      headers: args.headers,
      replyToMessageId: args.thread?.threadRef ?? null,
    });
    return {
      ok: res.ok,
      providerMessageId: res.providerMessageId,
      threadRef: res.providerMessageId ?? res.conversationId,
      rfc822MessageId: res.rfc822MessageId,
      error: res.error,
    };
  }

  const { raw } = buildRawMessage({
    from: mailbox.email,
    fromName: mailbox.displayName,
    to: args.to,
    toName: args.toName,
    subject: args.subject,
    bodyText: args.bodyText,
    bodyHtml: args.bodyHtml,
    headers: args.headers,
    inReplyTo: args.thread?.rfc822MessageId ?? null,
    references: args.thread?.rfc822MessageId ?? null,
  });
  const res = await sendGmailMessage({
    accessToken: args.accessToken,
    raw,
    threadId: args.thread?.threadRef ?? null,
  });
  if (!res.ok) {
    return { ok: false, providerMessageId: null, threadRef: null, rfc822MessageId: null, error: res.error };
  }
  // Read back the RFC822 Message-ID + threadId so later touches can thread.
  let rfc822 = res.rfc822MessageId;
  let threadId = res.threadId;
  if (res.providerMessageId) {
    const meta = await fetchGmailMessageMeta({
      accessToken: args.accessToken,
      providerMessageId: res.providerMessageId,
    });
    rfc822 = meta.rfc822MessageId ?? rfc822;
    threadId = meta.threadId ?? threadId;
  }
  return {
    ok: true,
    providerMessageId: res.providerMessageId,
    threadRef: threadId,
    rfc822MessageId: rfc822,
  };
}

async function loadThreadRefs(
  organizationId: string,
  sequenceId: string | null,
): Promise<{ threadRef: string | null; rfc822MessageId: string | null } | null> {
  if (!sequenceId) return null;
  const db = buildDb();
  const rows = await db.query<{ thread_ref: string | null; rfc822_message_id: string | null }>(
    `SELECT thread_ref, rfc822_message_id
       FROM sdr_messages
      WHERE organization_id = $1 AND sequence_id = $2 AND touch_index = 0
      LIMIT 1`,
    organizationId,
    sequenceId,
  );
  const row = rows[0];
  if (!row) return null;
  return { threadRef: row.thread_ref, rfc822MessageId: row.rfc822_message_id };
}

/** Replies keep the touch-1 subject prefixed with "Re:". */
function threadedSubject(subject: string, touchIndex: number): string {
  if (touchIndex === 0) return subject;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function buildUnsubscribeUrl(organizationId: string, email: string, messageId: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
  const token = createUnsubscribeToken({
    organizationId,
    email,
    messageId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  });
  return `${base}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

async function suppressUndeliverable(organizationId: string, email: string, messageId: string): Promise<void> {
  const db = buildDb();
  await db.execute(
    `INSERT INTO sdr_suppressions (id, organization_id, email, reason, source_message_id)
     VALUES ($1, $2, $3, 'bounce_hard', $4)
     ON CONFLICT DO NOTHING`,
    randomUUID(),
    organizationId,
    email,
    messageId,
  );
}

/** Mark a sequence completed once all its touches have left the queue. */
async function maybeCompleteSequence(organizationId: string, sequenceId: string | null): Promise<void> {
  if (!sequenceId) return;
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_sequences s
        SET status = 'completed', next_send_at = NULL, updated_at = NOW()
      WHERE s.organization_id = $1 AND s.id = $2 AND s.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM sdr_messages m
           WHERE m.sequence_id = s.id AND m.status = 'queued'
        )`,
    organizationId,
    sequenceId,
  );
}

/** Auto-pause the mailbox if bounce/complaint rates cross the reputation cliff. */
async function maybeAutoPause(mailbox: MailboxRecord): Promise<void> {
  const health = await computeMailboxHealth(mailbox.organizationId, mailbox);
  if (health.totalSent30d < 20) return;
  if (health.complaintRate >= COMPLAINT_PAUSE_RATE) {
    await pauseMailbox(
      mailbox.organizationId,
      mailbox.id,
      `Auto-paused: complaint rate ${(health.complaintRate * 100).toFixed(2)}% exceeds threshold.`,
    );
  } else if (health.bounceRate >= HARD_BOUNCE_PAUSE_RATE) {
    await pauseMailbox(
      mailbox.organizationId,
      mailbox.id,
      `Auto-paused: bounce rate ${(health.bounceRate * 100).toFixed(2)}% exceeds threshold.`,
    );
  }
}
