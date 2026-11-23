import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  organization_id?: unknown;
  mailbox_id?: unknown;
  pause_reason?: unknown;
};

type PauseMailboxResult = {
  ok: boolean;
  organization_id: string;
  mailbox_id: string;
  paused_at: string;
  pause_reason: string;
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getDbFromContext(ctx: HandlerContext): Queryable | null {
  const maybeCtx = ctx as unknown;
  if (!isRecord(maybeCtx)) return null;

  const directDb = maybeCtx.db;
  if (isRecord(directDb) && typeof directDb.query === "function") {
    return directDb as Queryable;
  }

  const runtime = maybeCtx.runtime;
  if (isRecord(runtime)) {
    const runtimeDb = runtime.db;
    if (isRecord(runtimeDb) && typeof runtimeDb.query === "function") {
      return runtimeDb as Queryable;
    }
  }

  return null;
}

function getOrganizationIdFromContext(ctx: HandlerContext): string | null {
  const maybeCtx = ctx as unknown;
  if (!isRecord(maybeCtx)) return null;

  const directOrgId = asNonEmptyString(maybeCtx.organization_id);
  if (directOrgId) return directOrgId;

  const org = maybeCtx.organization;
  if (isRecord(org)) {
    const orgId = asNonEmptyString(org.id);
    if (orgId) return orgId;
  }

  const session = maybeCtx.session;
  if (isRecord(session)) {
    const sessionOrgId = asNonEmptyString(session.organization_id);
    if (sessionOrgId) return sessionOrgId;
  }

  return null;
}

function parseArgs(ctx: HandlerContext, args: Args): {
  organizationId: string | null;
  mailboxId: string | null;
  pauseReason: string | null;
} {
  const organizationId =
    asNonEmptyString(args.organization_id) ?? getOrganizationIdFromContext(ctx);
  const mailboxId = asNonEmptyString(args.mailbox_id);
  const pauseReason = asNonEmptyString(args.pause_reason);

  return { organizationId, mailboxId, pauseReason };
}

function success(result: PauseMailboxResult): HandlerResult {
  return {
    ok: true,
    data: result,
  } as HandlerResult;
}

function failure(code: string, message: string, details?: Record<string, unknown>): HandlerResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  } as HandlerResult;
}

export async function handlePauseMailboxSending(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const { organizationId, mailboxId, pauseReason } = parseArgs(ctx, args);

  if (!organizationId) {
    return failure("invalid_args", "organization_id is required");
  }
  if (!mailboxId) {
    return failure("invalid_args", "mailbox_id is required");
  }
  if (!pauseReason) {
    return failure("invalid_args", "pause_reason is required");
  }

  const db = getDbFromContext(ctx);
  if (!db) {
    return failure("runtime_unavailable", "database handle is unavailable in handler context");
  }

  try {
    const sql = `
      UPDATE sdr_mailboxes
      SET
        paused_at = COALESCE(paused_at, NOW()),
        pause_reason = $3,
        updated_at = NOW()
      WHERE organization_id = $1
        AND id = $2
      RETURNING id, organization_id, paused_at, pause_reason
    `;
    const updated = await db.query(sql, [organizationId, mailboxId, pauseReason]);
    const row = updated.rows?.[0];

    if (!row) {
      return failure("not_found", "mailbox not found for organization", {
        organization_id: organizationId,
        mailbox_id: mailboxId,
      });
    }

    return success({
      ok: true,
      organization_id: String(row.organization_id),
      mailbox_id: String(row.id),
      paused_at: row.paused_at instanceof Date ? row.paused_at.toISOString() : String(row.paused_at),
      pause_reason: String(row.pause_reason),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown database error";
    return failure("db_error", "failed to pause mailbox sending", { message });
  }
}
