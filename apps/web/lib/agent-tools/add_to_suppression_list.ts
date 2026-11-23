import { randomUUID } from "crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { sql } from "@vercel/postgres";

type Args = {
  organization_id?: unknown;
  mailbox_id?: unknown;
  email?: unknown;
  domain?: unknown;
  reason?: unknown;
  source?: unknown;
  actor_user_id?: unknown;
  actor_type?: unknown;
};

type Target =
  | { kind: "email"; value: string }
  | { kind: "domain"; value: string };

const EMAIL_REGEX =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(email: string): string | null {
  const normalized: string = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(normalized)) return null;
  return normalized;
}

function normalizeDomain(domain: string): string | null {
  let d: string = domain.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0] ?? d;
  d = d.split("?")[0] ?? d;
  d = d.split("#")[0] ?? d;
  d = d.replace(/\.$/, "");
  if (!d || d.includes("@")) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return null;
  return d;
}

function parseTarget(args: Args): Target | null {
  const emailRaw: string | null = normalizeString(args.email);
  const domainRaw: string | null = normalizeString(args.domain);

  if (emailRaw) {
    const email: string | null = normalizeEmail(emailRaw);
    if (!email) return null;
    return { kind: "email", value: email };
  }

  if (domainRaw) {
    const domain: string | null = normalizeDomain(domainRaw);
    if (!domain) return null;
    return { kind: "domain", value: domain };
  }

  return null;
}

function success(payload: Record<string, unknown>): HandlerResult {
  return {
    ok: true,
    data: payload,
  } as HandlerResult;
}

function failure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HandlerResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  } as HandlerResult;
}

export async function handleAddToSuppressionList(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const organizationId: string | null = normalizeString(args.organization_id);
    if (!organizationId) {
      return failure("invalid_arguments", "organization_id is required");
    }

    const target: Target | null = parseTarget(args);
    if (!target) {
      return failure(
        "invalid_arguments",
        "Either a valid email or a valid domain is required",
      );
    }

    const reason: string =
      normalizeString(args.reason) ??
      "unspecified_unsubscribe_or_deliverability_event";
    const source: string =
      normalizeString(args.source) ?? "agent_tool_add_to_suppression_list";
    const mailboxId: string | null = normalizeString(args.mailbox_id);
    const actorUserId: string | null = normalizeString(args.actor_user_id);
    const actorType: string = normalizeString(args.actor_type) ?? "system";

    const suppressionId: string = randomUUID();
    const nowIso: string = new Date().toISOString();

    let upserted;
    if (target.kind === "email") {
      upserted = await sql`
        INSERT INTO sdr_suppressions (
          id,
          organization_id,
          mailbox_id,
          email,
          domain,
          reason,
          source,
          actor_user_id,
          actor_type,
          created_at,
          updated_at
        )
        VALUES (
          ${suppressionId},
          ${organizationId},
          ${mailboxId},
          ${target.value},
          NULL,
          ${reason},
          ${source},
          ${actorUserId},
          ${actorType},
          ${nowIso},
          ${nowIso}
        )
        ON CONFLICT (organization_id, email)
        DO UPDATE SET
          mailbox_id = COALESCE(EXCLUDED.mailbox_id, sdr_suppressions.mailbox_id),
          reason = EXCLUDED.reason,
          source = EXCLUDED.source,
          actor_user_id = EXCLUDED.actor_user_id,
          actor_type = EXCLUDED.actor_type,
          updated_at = EXCLUDED.updated_at
        RETURNING id, organization_id, mailbox_id, email, domain, reason, source, actor_user_id, actor_type, created_at, updated_at
      `;
    } else {
      upserted = await sql`
        INSERT INTO sdr_suppressions (
          id,
          organization_id,
          mailbox_id,
          email,
          domain,
          reason,
          source,
          actor_user_id,
          actor_type,
          created_at,
          updated_at
        )
        VALUES (
          ${suppressionId},
          ${organizationId},
          ${mailboxId},
          NULL,
          ${target.value},
          ${reason},
          ${source},
          ${actorUserId},
          ${actorType},
          ${nowIso},
          ${nowIso}
        )
        ON CONFLICT (organization_id, domain)
        DO UPDATE SET
          mailbox_id = COALESCE(EXCLUDED.mailbox_id, sdr_suppressions.mailbox_id),
          reason = EXCLUDED.reason,
          source = EXCLUDED.source,
          actor_user_id = EXCLUDED.actor_user_id,
          actor_type = EXCLUDED.actor_type,
          updated_at = EXCLUDED.updated_at
        RETURNING id, organization_id, mailbox_id, email, domain, reason, source, actor_user_id, actor_type, created_at, updated_at
      `;
    }

    const canceled = await sql`
      UPDATE sdr_sequence_touches
      SET
        status = 'canceled',
        cancellation_reason = 'suppressed',
        updated_at = ${nowIso}
      WHERE
        organization_id = ${organizationId}
        AND status IN ('queued', 'scheduled', 'pending')
        AND (
          (${target.kind === "email"} AND lower(prospect_email) = ${
            target.kind === "email" ? target.value : ""
          })
          OR
          (${target.kind === "domain"} AND lower(prospect_domain) = ${
            target.kind === "domain" ? target.value : ""
          })
        )
      RETURNING id
    `;

    return success({
      suppression: upserted.rows[0] ?? null,
      canceled_touch_count: canceled.rowCount ?? 0,
      target_kind: target.kind,
      target_value: target.value,
    });
  } catch (error: unknown) {
    return failure("internal_error", "Failed to add suppression", {
      message: error instanceof Error ? error.message : "unknown_error",
      tool: "add_to_suppression_list",
      has_ctx: Boolean(ctx),
    });
  }
}
