/**
 * Company-local agent tool: `pause_mailbox_sending`.
 *
 * Confirm-gated mutation declared by the SDR domain. The autonomous deliverability
 * agent calls this when a mailbox crosses a guardrail threshold — bounce-rate spike,
 * spam-complaint surge, authentication (SPF/DKIM/DMARC) failure, or an operator
 * kill-switch. It is the "stop sending from this mailbox NOW" step:
 *
 *   1. stamps `paused_at = NOW()` and records `pause_reason` on the `sdr_mailboxes`
 *      row (tenant-scoped by `organization_id`) so the dispatch cron loop, which
 *      only picks mailboxes with `paused_at IS NULL`, skips it on the next tick; and
 *   2. publishes `sdr.mailbox.paused` so @nexus/notifications alerts the founder
 *      who owns the mailbox and the Nexus operators, and the pause lands on the
 *      @nexus/admin-console audit trail.
 *
 * Autonomy = autonomous: analysis tools run inline via the generic LLM handler,
 * but this mutation routes through the cross-boundary bridge, which invokes us with
 * a `HandlerContext` ({ db, events }) and the agent-supplied args. It is
 * confirm-gated: the bridge must pass `confirm: true` (a human- or policy-approved
 * action) before the write runs. Registered in `./_dispatch.ts` under
 * `DOMAIN_DISPATCH`. Returns the lego-standard `HandlerResult` ({ status, body }).
 */

import type { HandlerContext, HandlerResult, DbRow } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

interface ParsedArgs {
  readonly organizationId: string;
  readonly mailboxId: string;
  readonly pauseReason: string;
  readonly actorUserId: string | null;
}

/** Coerce to a trimmed non-empty string, or null. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Interpret the confirm gate. Accepts the boolean `true` or the strings
 * "true"/"yes"/"1" (the bridge may serialize the flag), everything else is
 * treated as "not confirmed".
 */
function isConfirmed(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized: string = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  return false;
}

/** Validate + normalize the agent-supplied args. Returns null on bad input. */
function parseArgs(args: Args): ParsedArgs | null {
  const organizationId: string | null = asNonEmptyString(
    args.organization_id ?? args.organizationId,
  );
  const mailboxId: string | null = asNonEmptyString(args.mailbox_id ?? args.mailboxId);
  const pauseReason: string | null = asNonEmptyString(args.pause_reason ?? args.pauseReason);

  if (!organizationId || !mailboxId || !pauseReason) {
    return null;
  }

  return {
    organizationId,
    mailboxId,
    pauseReason,
    actorUserId: asNonEmptyString(args.actor_user_id ?? args.actorUserId),
  };
}

interface PausedMailbox {
  readonly id: string;
  readonly organizationId: string;
  readonly pausedAt: string;
  readonly pauseReason: string;
}

/**
 * Stamp the pause on the mailbox, tenant-scoped. Returns the updated row, or
 * null when no mailbox matches the (id, organization_id) pair — i.e. a bad id
 * or a cross-tenant attempt. Idempotent: re-pausing an already-paused mailbox
 * refreshes `paused_at`/`pause_reason` rather than erroring.
 */
async function pauseMailbox(
  ctx: HandlerContext,
  parsed: ParsedArgs,
): Promise<PausedMailbox | null> {
  const rows = await ctx.db.query<DbRow>(
    `UPDATE sdr_mailboxes
        SET paused_at = NOW(),
            pause_reason = $1,
            updated_at = NOW()
      WHERE id = $2
        AND organization_id = $3
      RETURNING id, organization_id, paused_at, pause_reason`,
    parsed.pauseReason,
    parsed.mailboxId,
    parsed.organizationId,
  );

  const first = rows[0];
  if (!first) {
    return null;
  }

  return {
    id: String(first.id),
    organizationId: String(first.organization_id),
    pausedAt: String(first.paused_at),
    pauseReason: String(first.pause_reason),
  };
}

export async function handlePauseMailboxSending(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  // Confirm gate first: this is a mutation, so an unconfirmed call never writes.
  if (!isConfirmed(args.confirm)) {
    return {
      status: 412,
      body: "pause_mailbox_sending is a confirm-gated mutation; pass confirm=true to execute.",
    };
  }

  const parsed: ParsedArgs | null = parseArgs(args);
  if (!parsed) {
    return {
      status: 400,
      body: "pause_mailbox_sending requires organization_id, mailbox_id, and pause_reason as non-empty strings.",
    };
  }

  try {
    const mailbox: PausedMailbox | null = await pauseMailbox(ctx, parsed);
    if (!mailbox) {
      return {
        status: 404,
        body: `No mailbox ${parsed.mailboxId} found for organization ${parsed.organizationId}.`,
      };
    }

    // Fire-and-forget: the pause is already committed, so a bus outage must
    // never surface as a handler failure. @nexus/notifications consumes this to
    // alert the founder + operators; @nexus/admin-console records the audit row.
    try {
      await ctx.events.publish("sdr.mailbox.paused", {
        mailbox_id: mailbox.id,
        organization_id: mailbox.organizationId,
        pause_reason: mailbox.pauseReason,
        paused_at: mailbox.pausedAt,
        actor_user_id: parsed.actorUserId,
        source: "agent_tool",
      });
    } catch {
      /* non-fatal: mailbox pause is already persisted */
    }

    return {
      status: 200,
      body: {
        paused: true,
        mailbox_id: mailbox.id,
        organization_id: mailbox.organizationId,
        pause_reason: mailbox.pauseReason,
        paused_at: mailbox.pausedAt,
        notified: true,
      },
    };
  } catch (error: unknown) {
    const message: string =
      error instanceof Error
        ? error.message
        : "Unknown error while pausing mailbox sending.";
    return {
      status: 500,
      body: `pause_mailbox_sending failed: ${message}`,
    };
  }
}
