import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  organization_id?: string;
  sequence_id?: string;
  contact_id?: string;
  thread_id?: string;
  scope?: "customer" | "operator";
  reason?: "unsubscribe" | "legal_threat" | "unclear" | "low_confidence";
  confidence?: number;
  note?: string;
};

type SqlClient = {
  query: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows?: Array<Record<string, unknown>> }>;
};

type CtxWithSql = HandlerContext & {
  db?: SqlClient;
  sql?: SqlClient;
};

const ALLOWED_REASONS = new Set<NonNullable<Args["reason"]>>([
  "unsubscribe",
  "legal_threat",
  "unclear",
  "low_confidence",
]);

function asSqlClient(ctx: CtxWithSql): SqlClient | null {
  if (ctx.db && typeof ctx.db.query === "function") {
    return ctx.db;
  }
  if (ctx.sql && typeof ctx.sql.query === "function") {
    return ctx.sql;
  }
  return null;
}

function toSafeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function handleEnqueueReplyForHumanReview(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const sql = asSqlClient(ctx as CtxWithSql);
  if (!sql) {
    return {
      ok: false,
      error: "missing_db_client",
      message: "No database client found on handler context.",
    } as HandlerResult;
  }

  const organizationId = toStringOrNull(args.organization_id);
  const sequenceId = toStringOrNull(args.sequence_id);
  const contactId = toStringOrNull(args.contact_id);
  const threadId = toStringOrNull(args.thread_id);
  const scope = (toStringOrNull(args.scope) ?? "operator") as "customer" | "operator";
  const reason = toStringOrNull(args.reason) as Args["reason"] | null;
  const note = toStringOrNull(args.note);
  const confidence = toSafeNumber(args.confidence);

  if (!organizationId || !sequenceId || !contactId || !threadId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message:
        "organization_id, sequence_id, contact_id, and thread_id are required string arguments.",
    } as HandlerResult;
  }

  if (scope !== "customer" && scope !== "operator") {
    return {
      ok: false,
      error: "invalid_scope",
      message: "scope must be either 'customer' or 'operator'.",
    } as HandlerResult;
  }

  if (!reason || !ALLOWED_REASONS.has(reason)) {
    return {
      ok: false,
      error: "invalid_reason",
      message: "reason must be one of: unsubscribe, legal_threat, unclear, low_confidence.",
    } as HandlerResult;
  }

  if (reason === "low_confidence") {
    if (confidence === null) {
      return {
        ok: false,
        error: "invalid_confidence",
        message: "confidence is required when reason is low_confidence.",
      } as HandlerResult;
    }
    if (confidence >= 0.85) {
      return {
        ok: false,
        error: "confidence_not_below_threshold",
        message: "low_confidence reason requires confidence < 0.85.",
      } as HandlerResult;
    }
  }

  const reviewId = randomUUID();

  try {
    await sql.query(
      `
      INSERT INTO sdr_review_queue (
        id,
        organization_id,
        sequence_id,
        contact_id,
        thread_id,
        scope,
        reason,
        confidence,
        note,
        status,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW(), NOW()
      )
      `,
      [
        reviewId,
        organizationId,
        sequenceId,
        contactId,
        threadId,
        scope,
        reason,
        confidence,
        note,
      ],
    );

    await sql.query(
      `
      UPDATE sdr_sequences
      SET status = 'paused', paused_reason = 'human_review', updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
      `,
      [sequenceId, organizationId],
    );

    return {
      ok: true,
      data: {
        review_queue_id: reviewId,
        sequence_paused: true,
        scope,
        reason,
      },
    } as HandlerResult;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error while enqueueing human review.";
    return {
      ok: false,
      error: "enqueue_reply_for_human_review_failed",
      message,
    } as HandlerResult;
  }
}
