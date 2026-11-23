import { randomUUID } from "node:crypto";

interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface PgPoolClient {
  query: (sql: string, params?: unknown[]) => Promise<PgQueryResult>;
  release: () => void;
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<PgQueryResult>;
  connect: () => Promise<PgPoolClient>;
}

let _pool: PgPool | null = null;

/**
 * Lazily construct a singleton `pg` pool. `pg` is externalized in
 * next.config.js (serverComponentsExternalPackages), so a runtime require
 * resolves it from the serverless function's node_modules and it is never
 * bundled for the client — matching the substrate's @/lib/db pattern.
 */
function getPool(): PgPool {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => PgPool;
  };
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

export type ReviewQueueReason = "unclear" | "low_confidence" | "legal_threat";
export type ReviewClassification =
  | "positive_interest"
  | "not_interested"
  | "objection"
  | "unsubscribe"
  | "out_of_office"
  | "referral"
  | "legal_threat";
export type ReviewAction = "send_drafted_touch" | "close" | "suppress" | "hand_to_customer";

export interface ReviewQueueItem {
  id: string;
  messageId: string;
  reason: ReviewQueueReason;
  classifierGuess: ReviewClassification | null;
  classifierConfidence: number | null;
  createdAt: string;
  ageSeconds: number;
  prospectName: string | null;
  prospectEmail: string | null;
  subject: string | null;
  bodyText: string | null;
}

export interface ReviewThreadMessage {
  id: string;
  direction: string;
  subject: string | null;
  bodyText: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface ReviewThreadDetail {
  id: string;
  reason: ReviewQueueReason;
  classifierGuess: ReviewClassification | null;
  classifierConfidence: number | null;
  createdAt: string;
  ageSeconds: number;
  messageId: string;
  threadRef: string | null;
  prospectName: string | null;
  prospectEmail: string | null;
  messages: ReviewThreadMessage[];
}

export interface ResolveReviewInput {
  reviewId: string;
  organizationId: string;
  operatorId: string;
  correctedClassification: ReviewClassification;
  action: ReviewAction;
  notes: string | null;
}

function rowToQueueItem(row: Record<string, unknown>): ReviewQueueItem {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    reason: String(row.reason) as ReviewQueueReason,
    classifierGuess: (row.classifier_guess as ReviewClassification | null) ?? null,
    classifierConfidence:
      row.classifier_confidence === null || row.classifier_confidence === undefined
        ? null
        : Number(row.classifier_confidence),
    createdAt: String(row.created_at),
    ageSeconds: Number(row.age_seconds ?? 0),
    prospectName: (row.prospect_name as string | null) ?? null,
    prospectEmail: (row.prospect_email as string | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    bodyText: (row.body_text as string | null) ?? null,
  };
}

export async function listOpenReviewQueue(
  organizationId: string,
  limit = 100,
): Promise<{ items: ReviewQueueItem[]; autoHandledToday: number }> {
  const client = await getPool().connect();
  try {
    const queueResult = await client.query(
      `
      SELECT
        rq.id,
        rq.message_id,
        rq.reason,
        rq.classifier_guess,
        rq.classifier_confidence,
        rq.created_at,
        EXTRACT(EPOCH FROM (NOW() - rq.created_at))::bigint AS age_seconds,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), p.full_name) AS prospect_name,
        p.email AS prospect_email,
        m.subject,
        m.body_text
      FROM sdr_review_queue rq
      INNER JOIN sdr_messages m ON m.id = rq.message_id
      LEFT JOIN sdr_prospects p ON p.id = m.prospect_id
      WHERE rq.organization_id = $1
        AND rq.status = 'open'
      ORDER BY rq.created_at ASC
      LIMIT $2
      `,
      [organizationId, limit],
    );

    const autoHandledResult = await client.query(
      `
      SELECT COUNT(*)::integer AS count
      FROM sdr_messages
      WHERE organization_id = $1
        AND direction = 'inbound'
        AND created_at >= date_trunc('day', NOW())
        AND status != 'needs_review'
      `,
      [organizationId],
    );

    return {
      items: queueResult.rows.map((row) => rowToQueueItem(row)),
      autoHandledToday: Number(autoHandledResult.rows[0]?.count ?? 0),
    };
  } finally {
    client.release();
  }
}

export async function getReviewThreadById(
  organizationId: string,
  reviewId: string,
): Promise<ReviewThreadDetail | null> {
  const client = await getPool().connect();
  try {
    const head = await client.query(
      `
      SELECT
        rq.id,
        rq.reason,
        rq.classifier_guess,
        rq.classifier_confidence,
        rq.created_at,
        EXTRACT(EPOCH FROM (NOW() - rq.created_at))::bigint AS age_seconds,
        rq.message_id,
        m.thread_ref,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), p.full_name) AS prospect_name,
        p.email AS prospect_email
      FROM sdr_review_queue rq
      INNER JOIN sdr_messages m ON m.id = rq.message_id
      LEFT JOIN sdr_prospects p ON p.id = m.prospect_id
      WHERE rq.organization_id = $1
        AND rq.id = $2
      LIMIT 1
      `,
      [organizationId, reviewId],
    );

    if (head.rowCount === 0) {
      return null;
    }

    const row = head.rows[0];
    const threadRef = (row.thread_ref as string | null) ?? null;
    let messagesResult;
    if (threadRef) {
      messagesResult = await client.query(
        `
        SELECT id, direction, subject, body_text, sent_at, created_at
        FROM sdr_messages
        WHERE organization_id = $1
          AND thread_ref = $2
        ORDER BY COALESCE(sent_at, created_at) ASC
        `,
        [organizationId, threadRef],
      );
    } else {
      messagesResult = await client.query(
        `
        SELECT id, direction, subject, body_text, sent_at, created_at
        FROM sdr_messages
        WHERE organization_id = $1
          AND id = $2
        `,
        [organizationId, String(row.message_id)],
      );
    }

    return {
      id: String(row.id),
      reason: String(row.reason) as ReviewQueueReason,
      classifierGuess: (row.classifier_guess as ReviewClassification | null) ?? null,
      classifierConfidence:
        row.classifier_confidence === null || row.classifier_confidence === undefined
          ? null
          : Number(row.classifier_confidence),
      createdAt: String(row.created_at),
      ageSeconds: Number(row.age_seconds ?? 0),
      messageId: String(row.message_id),
      threadRef,
      prospectName: (row.prospect_name as string | null) ?? null,
      prospectEmail: (row.prospect_email as string | null) ?? null,
      messages: messagesResult.rows.map((m) => ({
        id: String(m.id),
        direction: String(m.direction),
        subject: (m.subject as string | null) ?? null,
        bodyText: (m.body_text as string | null) ?? null,
        sentAt: (m.sent_at as string | null) ?? null,
        createdAt: String(m.created_at),
      })),
    };
  } finally {
    client.release();
  }
}

export async function resolveReview(input: ResolveReviewInput): Promise<{ ok: true }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query(
      `
      SELECT id, message_id, status
      FROM sdr_review_queue
      WHERE id = $1
        AND organization_id = $2
      FOR UPDATE
      `,
      [input.reviewId, input.organizationId],
    );

    if (lock.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error("review_not_found");
    }

    const status = String(lock.rows[0].status);
    if (status !== "open") {
      await client.query("ROLLBACK");
      throw new Error("already_resolved");
    }

    await client.query(
      `
      INSERT INTO sdr_review_decisions (
        id,
        organization_id,
        review_id,
        operator_id,
        corrected_classification,
        action,
        notes,
        decided_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `,
      [
        randomUUID(),
        input.organizationId,
        input.reviewId,
        input.operatorId,
        input.correctedClassification,
        input.action,
        input.notes,
      ],
    );

    await client.query(
      `
      UPDATE sdr_review_queue
      SET status = 'resolved',
          updated_at = NOW(),
          resolved_at = NOW()
      WHERE id = $1
        AND organization_id = $2
      `,
      [input.reviewId, input.organizationId],
    );

    if (input.action === "suppress") {
      const messageRes = await client.query(
        `
        SELECT m.id, p.email, p.company_domain
        FROM sdr_messages m
        LEFT JOIN sdr_prospects p ON p.id = m.prospect_id
        WHERE m.id = $1
          AND m.organization_id = $2
        LIMIT 1
        `,
        [String(lock.rows[0].message_id), input.organizationId],
      );

      if (messageRes.rowCount && messageRes.rows[0].email) {
        await client.query(
          `
          INSERT INTO sdr_suppressions (
            id, organization_id, email, domain, reason, source_message_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
          `,
          [
            randomUUID(),
            input.organizationId,
            String(messageRes.rows[0].email),
            (messageRes.rows[0].company_domain as string | null) ?? null,
            "operator_review_suppression",
            String(messageRes.rows[0].id),
          ],
        );
      }
    }

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
