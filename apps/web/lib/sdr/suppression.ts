import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export type SuppressionReason =
  | "unsubscribe_link"
  | "unsubscribe_reply"
  | "legal_threat"
  | "manual"
  | "bounce_hard"
  | "customer_upload";

export type SuppressionRecord = {
  id: string;
  organization_id: string;
  email: string | null;
  domain: string | null;
  reason: SuppressionReason;
  source_message_id: string | null;
  created_at: string;
};

export type ComplianceStats = {
  suppressedContacts: number;
  unsubscribesThisMonth: number;
  medianHonorSeconds: number;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

export async function upsertSuppression(input: {
  organizationId: string;
  email?: string | null;
  domain?: string | null;
  reason: SuppressionReason;
  sourceMessageId?: string | null;
  createdAt?: Date;
}): Promise<SuppressionRecord> {
  const email = input.email ? normalizeEmail(input.email) : null;
  const domain = input.domain ? normalizeDomain(input.domain) : null;

  if (!email && !domain) {
    throw new Error("Either email or domain is required for suppression");
  }

  const client = await pool.connect();
  try {
    const existing = await client.query<SuppressionRecord>(
      `SELECT id, organization_id, email, domain, reason, source_message_id, created_at::text
       FROM sdr_suppressions
       WHERE organization_id = $1
         AND (
          ($2::text IS NOT NULL AND email = $2)
          OR ($3::text IS NOT NULL AND domain = $3)
         )
       ORDER BY created_at ASC
       LIMIT 1`,
      [input.organizationId, email, domain],
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const inserted = await client.query<SuppressionRecord>(
      `INSERT INTO sdr_suppressions (
          id, organization_id, email, domain, reason, source_message_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, organization_id, email, domain, reason, source_message_id, created_at::text`,
      [id, input.organizationId, email, domain, input.reason, input.sourceMessageId ?? null, createdAt.toISOString()],
    );

    return inserted.rows[0];
  } finally {
    client.release();
  }
}

export async function recordUnsubscribeEvent(input: {
  tokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  eventTimestamp?: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO sdr_unsubscribe_events (id, token_hash, ip_address, user_agent, event_timestamp)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      input.tokenHash,
      input.ipAddress,
      input.userAgent,
      (input.eventTimestamp ?? new Date()).toISOString(),
    ],
  );
}

export async function listSuppressionsByOrg(params: {
  organizationId: string;
  reason?: string;
  query?: string;
  limit?: number;
}): Promise<SuppressionRecord[]> {
  const values: Array<string | number | null> = [params.organizationId];
  const clauses: string[] = [`organization_id = $1`];

  if (params.reason) {
    values.push(params.reason);
    clauses.push(`reason = $${values.length}`);
  }

  if (params.query) {
    const q = `%${params.query.toLowerCase()}%`;
    values.push(q);
    clauses.push(`(LOWER(COALESCE(email, '')) LIKE $${values.length} OR LOWER(COALESCE(domain, '')) LIKE $${values.length})`);
  }

  values.push(params.limit ?? 200);

  const sql = `
    SELECT id, organization_id, email, domain, reason, source_message_id, created_at::text
    FROM sdr_suppressions
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${values.length}
  `;

  const result = await pool.query<SuppressionRecord>(sql, values);
  return result.rows;
}

export async function getComplianceStats(organizationId: string): Promise<ComplianceStats> {
  const [suppressedResult, unsubscribedResult, medianResult] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM sdr_suppressions
       WHERE organization_id = $1`,
      [organizationId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM sdr_suppressions
       WHERE organization_id = $1
         AND reason = 'unsubscribe_link'
         AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
      [organizationId],
    ),
    pool.query<{ median_seconds: string | null }>(
      `WITH ev AS (
         SELECT token_hash, MIN(event_timestamp) AS event_ts
         FROM sdr_unsubscribe_events
         GROUP BY token_hash
       ),
       sup AS (
         SELECT created_at, encode(digest(organization_id::text || ':' || email, 'sha256'), 'hex') AS k
         FROM sdr_suppressions
         WHERE organization_id = $1
           AND reason = 'unsubscribe_link'
           AND email IS NOT NULL
       )
       SELECT
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (sup.created_at - ev.event_ts))
         )::text AS median_seconds
       FROM sup
       JOIN ev ON ev.token_hash = sup.k`,
      [organizationId],
    ),
  ]);

  return {
    suppressedContacts: Number(suppressedResult.rows[0]?.count ?? 0),
    unsubscribesThisMonth: Number(unsubscribedResult.rows[0]?.count ?? 0),
    medianHonorSeconds: Math.max(0, Math.round(Number(medianResult.rows[0]?.median_seconds ?? 0))),
  };
}
