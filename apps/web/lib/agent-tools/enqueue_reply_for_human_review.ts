import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

type Scope = "customer" | "operator";

interface ParsedArgs {
  organizationId: string;
  threadId: string;
  reason: string;
  scope: Scope;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseScope(value: unknown): Scope {
  if (value === "operator") return "operator";
  return "customer";
}

function parseArgs(args: Args): ParsedArgs | null {
  const organizationId: string | null = asNonEmptyString(
    args.organization_id ?? args.organizationId,
  );
  const threadId: string | null = asNonEmptyString(args.thread_id ?? args.threadId);
  const reason: string | null = asNonEmptyString(args.reason);
  const scope: Scope = parseScope(args.scope);

  if (!organizationId || !threadId || !reason) {
    return null;
  }

  return {
    organizationId,
    threadId,
    reason,
    scope,
  };
}

function isPgPoolClient(value: unknown): value is {
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number; rows?: unknown[] }>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof (value as { query?: unknown }).query === "function"
  );
}

async function insertReviewQueueRow(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number }> },
  parsed: ParsedArgs,
): Promise<void> {
  await db.query(
    `
      INSERT INTO sdr_review_queue (
        id,
        organization_id,
        thread_id,
        scope,
        reason,
        status,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        'pending',
        NOW(),
        NOW()
      )
    `,
    [parsed.organizationId, parsed.threadId, parsed.scope, parsed.reason],
  );
}

async function pauseSequenceForThread(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number }> },
  parsed: ParsedArgs,
): Promise<void> {
  await db.query(
    `
      UPDATE sdr_sequence_enrollments
      SET
        status = 'paused',
        paused_reason = 'human_review_required',
        paused_at = NOW(),
        updated_at = NOW()
      WHERE organization_id = $1
        AND thread_id = $2
        AND status <> 'paused'
    `,
    [parsed.organizationId, parsed.threadId],
  );
}

export async function handleEnqueueReplyForHumanReview(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed: ParsedArgs | null = parseArgs(args);
  if (!parsed) {
    return {
      ok: false,
      error: "invalid_args",
      message:
        "enqueue_reply_for_human_review requires organization_id, thread_id, and reason as non-empty strings.",
    } as HandlerResult;
  }

  const maybeDb: unknown = (ctx as { db?: unknown }).db ?? (ctx as { pool?: unknown }).pool;
  if (!isPgPoolClient(maybeDb)) {
    return {
      ok: false,
      error: "db_unavailable",
      message: "Database client not available on handler context.",
    } as HandlerResult;
  }

  try {
    await insertReviewQueueRow(maybeDb, parsed);
    await pauseSequenceForThread(maybeDb, parsed);

    return {
      ok: true,
      data: {
        enqueued: true,
        organization_id: parsed.organizationId,
        thread_id: parsed.threadId,
        scope: parsed.scope,
        reason: parsed.reason,
        sequence_paused: true,
      },
    } as HandlerResult;
  } catch (error: unknown) {
    const message: string =
      error instanceof Error ? error.message : "Unknown error while enqueueing for human review.";
    return {
      ok: false,
      error: "enqueue_failed",
      message,
    } as HandlerResult;
  }
}
