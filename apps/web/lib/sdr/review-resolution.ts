import { randomUUID } from "crypto";
import { Pool } from "pg";

export type AdminUser = {
  id: string;
  organizationId: string;
  email?: string | null;
};

export type ReviewQueueItem = {
  id: string;
  organizationId: string;
  messageId: string | null;
  sequenceId: string | null;
  prospectId: string | null;
  reason: string;
  classifierGuess: string | null;
  classifierConfidence: number | null;
  classifierPayload: Record<string, unknown>;
  status: string;
  assignedToUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subject: string | null;
  bodyText: string | null;
  direction: string | null;
  prospectName: string | null;
  prospectEmail: string | null;
  companyName: string | null;
};

export type ResolveReviewInput = {
  correctedClassification: string;
  action: "send_drafted_touch" | "close" | "suppress" | "hand_to_customer";
  notes: string | null;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function mapQueueRow(row: Record<string, unknown>): ReviewQueueItem {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    messageId: row.message_id ? String(row.message_id) : null,
    sequenceId: row.sequence_id ? String(row.sequence_id) : null,
    prospectId: row.prospect_id ? String(row.prospect_id) : null,
    reason: String(row.reason),
    classifierGuess: row.classifier_guess ? String(row.classifier_guess) : null,
    classifierConfidence:
      typeof row.classifier_confidence === "number" ? row.classifier_confidence : null,
    classifierPayload:
      row.classifier_payload && typeof row.classifier_payload === "object"
        ? (row.classifier_payload as Record<string, unknown>)
        : {},
    status: String(row.status),
    assignedToUserId: row.assigned_to_user_id ? String(row.assigned_to_user_id) : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    subject: row.subject ? String(row.subject) : null,
    bodyText: row.body_text ? String(row.body_text) : null,
    direction: row.direction ? String(row.direction) : null,
    prospectName: row.prospect_name ? String(row.prospect_name) : null,
    prospectEmail: row.prospect_email ? String(row.prospect_email) : null,
    companyName: row.company_name ? String(row.company_name) : null,
  };
}

export async function listOpenReviewQueue(admin: AdminUser): Promise<ReviewQueueItem[]> {
  const result = await pool.query(
    `
    SELECT
      rq.*,
      m.subject,
      m.body_text,
      m.direction,
      COALESCE(p.full_name, CONCAT_WS(' ', p.first_name, p.last_name)) AS prospect_name,
      p.email AS prospect_email,
      p.company_name
    FROM sdr_review_queue rq
    LEFT JOIN sdr_messages m ON m.id = rq.message_id
    LEFT JOIN sdr_prospects p ON p.id = rq.prospect_id
    WHERE rq.organization_id = $1
      AND rq.status = 'open'
    ORDER BY rq.created_at ASC
    `,
    [admin.organizationId],
  );

  return result.rows.map((row) => mapQueueRow(row));
}

export async function getReviewQueueItemById(
  admin: AdminUser,
  id: string,
): Promise<ReviewQueueItem | null> {
  const result = await pool.query(
    `
    SELECT
      rq.*,
      m.subject,
      m.body_text,
      m.direction,
      COALESCE(p.full_name, CONCAT_WS(' ', p.first_name, p.last_name)) AS prospect_name,
      p.email AS prospect_email,
      p.company_name
    FROM sdr_review_queue rq
    LEFT JOIN sdr_messages m ON m.id = rq.message_id
    LEFT JOIN sdr_prospects p ON p.id = rq.prospect_id
    WHERE rq.organization_id = $1
      AND rq.id = $2
    LIMIT 1
    `,
    [admin.organizationId, id],
  );

  if (result.rowCount === 0) return null;
  return mapQueueRow(result.rows[0]);
}

export async function resolveReviewQueueItem(
  admin: AdminUser,
  reviewId: string,
  input: ResolveReviewInput,
): Promise<{ ok: true }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reviewRes = await client.query(
      `
      SELECT id, organization_id, message_id, prospect_id, status
      FROM sdr_review_queue
      WHERE id = $1 AND organization_id = $2
      LIMIT 1
      `,
      [reviewId, admin.organizationId],
    );

    if (reviewRes.rowCount === 0) {
      throw new Error("Review item not found.");
    }

    const review = reviewRes.rows[0];
    if (review.status !== "open") {
      throw new Error("Review item is already resolved.");
    }

    await client.query(
      `
      INSERT INTO sdr_review_decisions
      (id, organization_id, review_id, operator_id, corrected_classification, action, notes, decided_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      `,
      [
        randomUUID(),
        admin.organizationId,
        reviewId,
        admin.id,
        input.correctedClassification,
        input.action,
        input.notes,
      ],
    );

    await client.query(
      `
      UPDATE sdr_review_queue
      SET
        status = 'resolved',
        assigned_to_user_id = $1,
        resolved_at = NOW(),
        updated_at = NOW()
      WHERE id = $2 AND organization_id = $3
      `,
      [admin.id, reviewId, admin.organizationId],
    );

    if (input.action === "suppress" && review.prospect_id) {
      await client.query(
        `
        INSERT INTO sdr_suppressions
        (id, organization_id, email, domain, reason, source_message_id, created_at)
        SELECT
          $1,
          $2,
          p.email,
          p.company_domain,
          $3,
          $4,
          NOW()
        FROM sdr_prospects p
        WHERE p.id = $5
        `,
        [randomUUID(), admin.organizationId, "operator_review_suppress", review.message_id, review.prospect_id],
      );
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

export async function getTodayAutoHandledCount(admin: AdminUser): Promise<number> {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM sdr_messages m
    WHERE m.organization_id = $1
      AND m.direction = 'inbound'
      AND m.created_at::date = NOW()::date
      AND NOT EXISTS (
        SELECT 1 FROM sdr_review_queue rq WHERE rq.message_id = m.id
      )
    `,
    [admin.organizationId],
  );
  return result.rows[0]?.count ?? 0;
}
