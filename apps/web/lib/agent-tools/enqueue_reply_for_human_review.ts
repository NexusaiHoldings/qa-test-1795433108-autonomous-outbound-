/**
 * Company-local agent tool: `enqueue_reply_for_human_review`.
 *
 * Confirm-gated mutation declared by the SDR domain. The autonomous reply
 * agent calls this when a prospect reply must NOT be auto-handled —
 * unsubscribe requests, legal threats, unclear intent, or classifier
 * confidence below the 0.85 routing threshold. It writes a pending
 * `sdr_review_queue` row (scoped to the customer or the operator) with the
 * escalation reason and pauses the thread's outreach sequence so no further
 * automated send goes out until a human clears the review.
 *
 * Registered in `./_dispatch.ts` under `DOMAIN_DISPATCH`; the substrate's
 * approved-actions cron route invokes it with a `HandlerContext`
 * ({ db, events }) and the agent-supplied args. Returns the lego-standard
 * `HandlerResult` ({ status, body }).
 */

import type { HandlerContext, HandlerResult, DbRow } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** Who owns the escalated review: the paying customer or the Nexus operator. */
type Scope = "customer" | "operator";

interface ParsedArgs {
  readonly organizationId: string;
  readonly threadId: string;
  readonly reason: string;
  readonly scope: Scope;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Scope defaults to "customer"; only an explicit "operator" escalates up. */
function parseScope(value: unknown): Scope {
  return value === "operator" ? "operator" : "customer";
}

function parseArgs(args: Args): ParsedArgs | null {
  const organizationId: string | null = asNonEmptyString(
    args.organization_id ?? args.organizationId,
  );
  const threadId: string | null = asNonEmptyString(args.thread_id ?? args.threadId);
  const reason: string | null = asNonEmptyString(args.reason);

  if (!organizationId || !threadId || !reason) {
    return null;
  }

  return {
    organizationId,
    threadId,
    reason,
    scope: parseScope(args.scope),
  };
}

/** Insert the pending review row and return its generated UUID. */
async function insertReviewQueueRow(
  ctx: HandlerContext,
  parsed: ParsedArgs,
): Promise<string> {
  const rows = await ctx.db.query<DbRow>(
    `INSERT INTO sdr_review_queue
       (organization_id, thread_id, scope, reason, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
     RETURNING id`,
    parsed.organizationId,
    parsed.threadId,
    parsed.scope,
    parsed.reason,
  );

  const first = rows[0];
  const reviewId = first ? (first.id as string | undefined) : undefined;
  if (!reviewId) {
    throw new Error("sdr_review_queue insert returned no id");
  }
  return reviewId;
}

/**
 * Pause every active enrollment on the thread so the dispatch loop skips it
 * until a human clears the review. Idempotent: already-paused rows are left
 * untouched by the `status <> 'paused'` guard.
 */
async function pauseSequenceForThread(
  ctx: HandlerContext,
  parsed: ParsedArgs,
): Promise<void> {
  await ctx.db.execute(
    `UPDATE sdr_sequence_enrollments
        SET status = 'paused',
            paused_reason = 'human_review_required',
            paused_at = NOW(),
            updated_at = NOW()
      WHERE organization_id = $1
        AND thread_id = $2
        AND status <> 'paused'`,
    parsed.organizationId,
    parsed.threadId,
  );
}

export async function handleEnqueueReplyForHumanReview(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed: ParsedArgs | null = parseArgs(args);
  if (!parsed) {
    return {
      status: 400,
      body: "enqueue_reply_for_human_review requires organization_id, thread_id, and reason as non-empty strings.",
    };
  }

  try {
    const reviewId: string = await insertReviewQueueRow(ctx, parsed);
    await pauseSequenceForThread(ctx, parsed);

    // Fire-and-forget: the EventBus swallows its own errors, but guard anyway
    // so a bus outage never fails an already-committed escalation.
    try {
      await ctx.events.publish("sdr.reply.escalated", {
        review_id: reviewId,
        organization_id: parsed.organizationId,
        thread_id: parsed.threadId,
        scope: parsed.scope,
        reason: parsed.reason,
      });
    } catch {
      /* non-fatal: review row is already persisted */
    }

    return {
      status: 200,
      body: {
        enqueued: true,
        review_id: reviewId,
        organization_id: parsed.organizationId,
        thread_id: parsed.threadId,
        scope: parsed.scope,
        reason: parsed.reason,
        sequence_paused: true,
      },
    };
  } catch (error: unknown) {
    const message: string =
      error instanceof Error
        ? error.message
        : "Unknown error while enqueueing reply for human review.";
    return {
      status: 500,
      body: `enqueue_reply_for_human_review failed: ${message}`,
    };
  }
}
