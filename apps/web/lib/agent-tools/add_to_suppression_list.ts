import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { sql } from "@vercel/postgres";

type Args = {
  organization_id?: string;
  organizationId?: string;
  email?: string;
  domain?: string;
  reason?: string;
  source?: string;
  actor_user_id?: string;
  actorUserId?: string;
  touch_statuses_to_cancel?: string[];
};

type ParsedTarget =
  | { kind: "email"; value: string; domain: string }
  | { kind: "domain"; value: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function toErrorResult(code: string, message: string): HandlerResult {
  return {
    ok: false,
    code,
    message,
  } as HandlerResult;
}

function toSuccessResult(data: Record<string, unknown>): HandlerResult {
  return {
    ok: true,
    ...data,
  } as HandlerResult;
}

function parseTarget(emailRaw: unknown, domainRaw: unknown): ParsedTarget | null {
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const domain = typeof domainRaw === "string" ? domainRaw.trim().toLowerCase() : "";

  if (email.length > 0) {
    if (!EMAIL_RE.test(email)) {
      return null;
    }
    const emailDomain = email.split("@")[1] ?? "";
    return { kind: "email", value: email, domain: emailDomain };
  }

  if (domain.length > 0) {
    const normalized = domain.startsWith("@") ? domain.slice(1) : domain;
    if (!DOMAIN_RE.test(normalized)) {
      return null;
    }
    return { kind: "domain", value: normalized };
  }

  return null;
}

function normalizeReason(reasonRaw: unknown): string {
  if (typeof reasonRaw !== "string") {
    return "unspecified";
  }
  const normalized = reasonRaw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "unspecified";
}

function normalizeSource(sourceRaw: unknown): string {
  if (typeof sourceRaw !== "string") {
    return "agent_tool";
  }
  const normalized = sourceRaw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "agent_tool";
}

export async function handleAddToSuppressionList(
  _ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId = args.organization_id ?? args.organizationId;
  if (!organizationId || typeof organizationId !== "string") {
    return toErrorResult("invalid_args", "organization_id is required");
  }

  const target = parseTarget(args.email, args.domain);
  if (!target) {
    return toErrorResult("invalid_args", "Provide a valid email or domain");
  }

  const reason = normalizeReason(args.reason);
  const source = normalizeSource(args.source);
  const actorUserId =
    typeof args.actor_user_id === "string"
      ? args.actor_user_id
      : typeof args.actorUserId === "string"
        ? args.actorUserId
        : null;

  const cancellationStatuses =
    Array.isArray(args.touch_statuses_to_cancel) && args.touch_statuses_to_cancel.length > 0
      ? args.touch_statuses_to_cancel.filter((s): s is string => typeof s === "string")
      : ["queued", "scheduled", "pending", "approved"];

  try {
    const suppressionInsert = await sql`
      INSERT INTO sdr_suppressions (
        id,
        organization_id,
        email,
        domain,
        reason,
        source,
        actor_user_id,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        ${organizationId},
        ${target.kind === "email" ? target.value : null},
        ${target.kind === "domain" ? target.value : null},
        ${reason},
        ${source},
        ${actorUserId},
        NOW(),
        NOW()
      )
      ON CONFLICT (organization_id, COALESCE(email, ''), COALESCE(domain, ''))
      DO UPDATE SET
        reason = EXCLUDED.reason,
        source = EXCLUDED.source,
        actor_user_id = EXCLUDED.actor_user_id,
        updated_at = NOW()
      RETURNING id, organization_id, email, domain, reason, source, actor_user_id, created_at, updated_at
    `;

    let canceledTouches = 0;

    if (target.kind === "email") {
      const cancelByEmail = await sql`
        UPDATE sdr_touches
        SET status = 'canceled',
            canceled_reason = ${`suppressed:${reason}`},
            canceled_at = NOW(),
            updated_at = NOW()
        WHERE organization_id = ${organizationId}
          AND lower(prospect_email) = ${target.value}
          AND status = ANY(${cancellationStatuses}::text[])
      `;
      canceledTouches += cancelByEmail.rowCount ?? 0;
    }

    const domainForCancel = target.kind === "domain" ? target.value : target.domain;
    if (domainForCancel) {
      const cancelByDomain = await sql`
        UPDATE sdr_touches
        SET status = 'canceled',
            canceled_reason = ${`suppressed:${reason}`},
            canceled_at = NOW(),
            updated_at = NOW()
        WHERE organization_id = ${organizationId}
          AND lower(split_part(prospect_email, '@', 2)) = ${domainForCancel}
          AND status = ANY(${cancellationStatuses}::text[])
      `;
      canceledTouches += cancelByDomain.rowCount ?? 0;
    }

    const suppression = suppressionInsert.rows[0] ?? null;
    return toSuccessResult({
      tool: "add_to_suppression_list",
      organization_id: organizationId,
      suppression,
      canceled_touches: canceledTouches,
      target: target.kind === "email" ? { email: target.value } : { domain: target.value },
    });
  } catch (error: unknown) {
    return toErrorResult(
      "internal_error",
      error instanceof Error ? error.message : "failed to add suppression",
    );
  }
}
