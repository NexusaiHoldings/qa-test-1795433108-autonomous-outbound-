import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { getPool } from "@nexus/identity-and-access";

type Args = {
  mailbox_id?: unknown;
  pause_reason?: unknown;
  confirm?: unknown;
  organization_id?: unknown;
};

type SessionLike = {
  user?: {
    id?: string | null;
  } | null;
} | null;

type ContextWithSession = HandlerContext & {
  session?: SessionLike;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function getOrganizationId(ctx: HandlerContext, args: Args): string | null {
  const fromArgs = asNonEmptyString(args.organization_id);
  if (fromArgs) {
    return fromArgs;
  }

  const candidateContext = ctx as Record<string, unknown>;
  const directOrgId = asNonEmptyString(candidateContext.organizationId);
  if (directOrgId) {
    return directOrgId;
  }

  const nestedOrgId = asNonEmptyString(
    (candidateContext.organization as { id?: unknown } | undefined)?.id,
  );
  return nestedOrgId;
}

function getActorId(ctx: HandlerContext): string | null {
  const cws = ctx as ContextWithSession;
  return asNonEmptyString(cws.session?.user?.id ?? null);
}

export async function handlePauseMailboxSending(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const mailboxId = asNonEmptyString(args.mailbox_id);
  const pauseReason = asNonEmptyString(args.pause_reason);
  const confirmed = asBoolean(args.confirm);
  const organizationId = getOrganizationId(ctx, args);

  if (!confirmed) {
    return {
      ok: false,
      error: "confirmation_required",
      message:
        "pause_mailbox_sending is a mutation and requires confirm=true before execution.",
      data: {
        requires_confirmation: true,
      },
    } as HandlerResult;
  }

  if (!mailboxId) {
    return {
      ok: false,
      error: "invalid_args",
      message: "mailbox_id is required.",
    } as HandlerResult;
  }

  if (!pauseReason) {
    return {
      ok: false,
      error: "invalid_args",
      message: "pause_reason is required.",
    } as HandlerResult;
  }

  if (!organizationId) {
    return {
      ok: false,
      error: "missing_organization",
      message: "organization_id is required for this mutation.",
    } as HandlerResult;
  }

  const pool = getPool();
  const actorId = getActorId(ctx);

  const updateResult = await pool.query<{
    id: string;
    paused_at: string;
    pause_reason: string;
    organization_id: string;
  }>(
    `
      UPDATE sdr_mailboxes
      SET
        paused_at = NOW(),
        pause_reason = $1,
        updated_at = NOW()
      WHERE id = $2
        AND organization_id = $3
      RETURNING id, paused_at, pause_reason, organization_id
    `,
    [pauseReason, mailboxId, organizationId],
  );

  if (updateResult.rowCount === 0) {
    return {
      ok: false,
      error: "not_found",
      message: "Mailbox not found for organization or already inaccessible.",
      data: {
        mailbox_id: mailboxId,
        organization_id: organizationId,
      },
    } as HandlerResult;
  }

  const mailbox = updateResult.rows[0];

  await pool.query(
    `
      INSERT INTO sdr_audit_log (
        id,
        organization_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata,
        created_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        'pause_mailbox_sending',
        'mailbox',
        $3,
        jsonb_build_object('pause_reason', $4, 'source', 'agent_tool'),
        NOW()
      )
    `,
    [organizationId, actorId, mailboxId, pauseReason],
  );

  return {
    ok: true,
    data: {
      mailbox_id: mailbox.id,
      organization_id: mailbox.organization_id,
      paused_at: mailbox.paused_at,
      pause_reason: mailbox.pause_reason,
      notification_queued: true,
    },
  } as HandlerResult;
}
