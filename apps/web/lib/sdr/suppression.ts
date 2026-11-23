import { randomUUID } from "crypto";
import { sql } from "@vercel/postgres";

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

  const existing = await sql<{
    id: string;
    organization_id: string;
    email: string | null;
    domain: string | null;
    reason: string;
    source_message_id: string | null;
    created_at: string;
  }>`
    SELECT id, organization_id, email, domain, reason, source_message_id, created_at
    FROM sdr_suppressions
    WHERE organization_id = ${params.organizationId}
      AND (
        (${email}::text IS NOT NULL AND email = ${email})
        OR
        (${domain}::text IS NOT NULL AND domain = ${domain})
      )
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return {
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      domain: row.domain,
      reason: reasonFromText(row.reason),
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at,
    };
  }

  const id = randomUUID();
  const inserted = await sql<{
    id: string;
    organization_id: string;
    email: string | null;
    domain: string | null;
    reason: string;
    source_message_id: string | null;
    created_at: string;
  }>`
    INSERT INTO sdr_suppressions (id, organization_id, email, domain, reason, source_message_id)
    VALUES (${id}, ${params.organizationId}, ${email}, ${domain}, ${params.reason}, ${params.sourceMessageId ?? null})
    RETURNING id, organization_id, email, domain, reason, source_message_id, created_at
  `;

  const row = inserted.rows[0];
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    domain: row.domain,
    reason: reasonFromText(row.reason),
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
  };
}

export async function recordUnsubscribeEvent(params: {
  tokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO sdr_unsubscribe_events (id, token_hash, ip_address, user_agent)
    VALUES (${randomUUID()}, ${params.tokenHash}, ${params.ipAddress}, ${params.userAgent})
  `;
}

export async function listSuppressions(organizationId: string, reason?: string): Promise<SuppressionRecord[]> {
  const query = reason
    ? sql<{
        id: string;
        organization_id: string;
        email: string | null;
        domain: string | null;
        reason: string;
        source_message_id: string | null;
        created_at: string;
      }>`
        SELECT id, organization_id, email, domain, reason, source_message_id, created_at
        FROM sdr_suppressions
        WHERE organization_id = ${organizationId} AND reason = ${reason}
        ORDER BY created_at DESC
      `
    : sql<{
        id: string;
        organization_id: string;
        email: string | null;
        domain: string | null;
        reason: string;
        source_message_id: string | null;
        created_at: string;
      }>`
        SELECT id, organization_id, email, domain, reason, source_message_id, created_at
        FROM sdr_suppressions
        WHERE organization_id = ${organizationId}
        ORDER BY created_at DESC
      `;

  const result = await query;
  return result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    domain: row.domain,
    reason: reasonFromText(row.reason),
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
  }));
}

export async function getSuppressionStats(organizationId: string): Promise<SuppressionStats> {
  const [suppressedResult, unsubThisMonthResult, medianResult] = await Promise.all([
    sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM sdr_suppressions
      WHERE organization_id = ${organizationId}
    `,
    sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM sdr_suppressions
      WHERE organization_id = ${organizationId}
        AND reason IN ('unsubscribe_link', 'unsubscribe_reply')
        AND created_at >= date_trunc('month', now())
    `,
    sql<{ median_seconds: string | null }>`
      WITH linked AS (
        SELECT
          EXTRACT(EPOCH FROM (s.created_at - m.sent_at)) AS seconds_diff
        FROM sdr_suppressions s
        JOIN sdr_messages m ON m.id = s.source_message_id
        WHERE s.organization_id = ${organizationId}
          AND s.reason IN ('unsubscribe_link', 'unsubscribe_reply')
          AND m.sent_at IS NOT NULL
          AND s.created_at >= date_trunc('month', now())
      )
      SELECT
        CASE WHEN COUNT(*) = 0 THEN NULL ELSE percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds_diff)::text END AS median_seconds
      FROM linked
    `,
  ]);

  return {
    suppressedContacts: Number(suppressedResult.rows[0]?.count ?? "0"),
    unsubscribesHonoredThisMonth: Number(unsubThisMonthResult.rows[0]?.count ?? "0"),
    medianTimeToHonorSeconds: Math.round(Number(medianResult.rows[0]?.median_seconds ?? "0")),
  };
}

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
