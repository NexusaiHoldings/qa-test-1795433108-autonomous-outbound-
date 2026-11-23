/**
 * CAN-SPAM / CCPA suppression ledger — data access for the SDR domain.
 *
 * Operationalizes the required disclaimer "customer must maintain suppression
 * lists": every opt-out (unsubscribe link/reply, legal threat, hard bounce,
 * manual add, or customer CSV upload) lands in sdr_suppressions, tenant-scoped
 * by organization_id. Reads/writes go through the substrate `pg` pool
 * (@/lib/db buildDb) with parameterized $1/$2 queries — never string
 * interpolation. Tables are declared in packages/db/company/sdr.ts.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";

export const SUPPRESSION_REASONS = [
  "unsubscribe_link",
  "unsubscribe_reply",
  "legal_threat",
  "manual",
  "bounce_hard",
  "customer_upload",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export type SuppressionRecord = {
  id: string;
  organizationId: string;
  email: string | null;
  domain: string | null;
  reason: SuppressionReason;
  sourceMessageId: string | null;
  createdAt: string;
};

export type SuppressionStats = {
  suppressedContacts: number;
  unsubscribesHonoredThisMonth: number;
  medianTimeToHonorSeconds: number;
};

type SuppressionRow = {
  id: string;
  organization_id: string;
  email: string | null;
  domain: string | null;
  reason: string;
  source_message_id: string | null;
  created_at: string | Date;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

function reasonFromText(input: string): SuppressionReason {
  if ((SUPPRESSION_REASONS as readonly string[]).includes(input)) {
    return input as SuppressionReason;
  }
  return "manual";
}

function toRecord(row: SuppressionRow): SuppressionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    domain: row.domain,
    reason: reasonFromText(row.reason),
    sourceMessageId: row.source_message_id,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * Resolve the caller's active organization id. The org lego exposes no
 * "list my orgs" handler, so (matching the substrate's /org page) we resolve
 * membership directly: the user's earliest-joined org is the active one.
 */
export async function getActiveOrganizationId(userId: string): Promise<string | null> {
  if (!userId) return null;
  const db = buildDb();
  const rows = await db.query<{ id: string }>(
    `SELECT o.id
       FROM organizations o
       JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = $1
      ORDER BY o.created_at ASC
      LIMIT 1`,
    userId,
  );
  return rows[0]?.id ?? null;
}

export async function addSuppression(params: {
  organizationId: string;
  email?: string | null;
  domain?: string | null;
  reason: SuppressionReason;
  sourceMessageId?: string | null;
}): Promise<SuppressionRecord> {
  const email = params.email ? normalizeEmail(params.email) : null;
  const domain = params.domain ? normalizeDomain(params.domain) : null;
  if (!email && !domain) {
    throw new Error("Either email or domain is required for suppression");
  }

  const db = buildDb();

  // Idempotent: if this org already suppresses this exact email/domain, return it.
  const existing = await db.query<SuppressionRow>(
    `SELECT id, organization_id, email, domain, reason, source_message_id, created_at
       FROM sdr_suppressions
      WHERE organization_id = $1
        AND (
          ($2::text IS NOT NULL AND email = $2)
          OR ($3::text IS NOT NULL AND domain = $3)
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    params.organizationId,
    email,
    domain,
  );

  if (existing.length > 0) {
    return toRecord(existing[0]);
  }

  const id = randomUUID();
  const inserted = await db.query<SuppressionRow>(
    `INSERT INTO sdr_suppressions (id, organization_id, email, domain, reason, source_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, organization_id, email, domain, reason, source_message_id, created_at`,
    id,
    params.organizationId,
    email,
    domain,
    params.reason,
    params.sourceMessageId ?? null,
  );

  return toRecord(inserted[0]);
}

export async function recordUnsubscribeEvent(params: {
  tokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<void> {
  const db = buildDb();
  await db.execute(
    `INSERT INTO sdr_unsubscribe_events (id, token_hash, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)`,
    randomUUID(),
    params.tokenHash,
    params.ipAddress,
    params.userAgent,
  );
}

export async function listSuppressions(
  organizationId: string,
  reason?: string,
): Promise<SuppressionRecord[]> {
  const db = buildDb();
  const rows = reason
    ? await db.query<SuppressionRow>(
        `SELECT id, organization_id, email, domain, reason, source_message_id, created_at
           FROM sdr_suppressions
          WHERE organization_id = $1 AND reason = $2
          ORDER BY created_at DESC`,
        organizationId,
        reason,
      )
    : await db.query<SuppressionRow>(
        `SELECT id, organization_id, email, domain, reason, source_message_id, created_at
           FROM sdr_suppressions
          WHERE organization_id = $1
          ORDER BY created_at DESC`,
        organizationId,
      );

  return rows.map(toRecord);
}

export async function getSuppressionStats(organizationId: string): Promise<SuppressionStats> {
  const db = buildDb();

  const [suppressedRows, unsubThisMonthRows, medianRows] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM sdr_suppressions
        WHERE organization_id = $1`,
      organizationId,
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM sdr_suppressions
        WHERE organization_id = $1
          AND reason IN ('unsubscribe_link', 'unsubscribe_reply')
          AND created_at >= date_trunc('month', now())`,
      organizationId,
    ),
    db.query<{ median_seconds: string | null }>(
      `WITH linked AS (
         SELECT EXTRACT(EPOCH FROM (s.created_at - m.sent_at)) AS seconds_diff
           FROM sdr_suppressions s
           JOIN sdr_messages m ON m.id = s.source_message_id
          WHERE s.organization_id = $1
            AND s.reason IN ('unsubscribe_link', 'unsubscribe_reply')
            AND m.sent_at IS NOT NULL
            AND s.created_at >= date_trunc('month', now())
       )
       SELECT CASE
                WHEN COUNT(*) = 0 THEN NULL
                ELSE percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds_diff)::text
              END AS median_seconds
         FROM linked`,
      organizationId,
    ),
  ]);

  return {
    suppressedContacts: Number(suppressedRows[0]?.count ?? "0"),
    unsubscribesHonoredThisMonth: Number(unsubThisMonthRows[0]?.count ?? "0"),
    medianTimeToHonorSeconds: Math.round(Number(medianRows[0]?.median_seconds ?? "0")),
  };
}

/**
 * Parse emails out of a do-not-contact CSV. Tolerant of header rows, quoting,
 * and multi-column files: any token that looks like an email is collected and
 * de-duplicated (normalized to lowercase).
 */
export function parseCsvEmails(csvText: string): string[] {
  const lines = csvText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const emails = new Set<string>();

  for (const line of lines) {
    const parts = line.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
    for (const part of parts) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) {
        emails.add(normalizeEmail(part));
      }
    }
  }

  return [...emails];
}
