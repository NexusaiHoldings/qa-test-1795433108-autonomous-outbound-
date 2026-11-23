/**
 * Company-local agent tool: `add_to_suppression_list`.
 *
 * Confirm-gated mutation declared by the SDR domain. The autonomous reply /
 * deliverability agents call this to permanently stop outreach to an address or
 * a whole domain. It is invoked on unsubscribe clicks, unsubscribe- or
 * legal-threat replies, hard bounces, and operator CSV imports:
 *
 *   1. upserts the target (an `email` OR a `domain`) into `sdr_suppressions`,
 *      tenant-scoped by `organization_id`, with the escalation `reason` (and an
 *      optional `source_message_id` linking the triggering message). Re-adding
 *      an already-suppressed target refreshes its reason rather than erroring —
 *      the "upsert" is emulated with UPDATE-then-INSERT because the table has no
 *      unique index to hang an ON CONFLICT on; and
 *   2. cancels every still-pending outbound touch to that target — the
 *      `sdr_messages` rows (the sequence touches) in a non-terminal workflow
 *      status (`draft | approved | queued`) whose prospect matches the
 *      suppressed email/domain — by stamping `status = 'cancelled'` and clearing
 *      `next_send_at` so the dispatch cron loop never sends them; and
 *   3. publishes `sdr.suppression.added` so @nexus/analytics-and-telemetry and
 *      the @nexus/admin-console audit trail record the suppression.
 *
 * Autonomy = autonomous: analysis tools run inline via the generic LLM handler,
 * but this mutation routes through the cross-boundary bridge, which invokes us
 * with a `HandlerContext` ({ db, events }) and the agent-supplied args. It is
 * confirm-gated: the bridge must pass `confirm: true` (a human- or
 * policy-approved action) before the write runs. Registered in `./_dispatch.ts`
 * under `DOMAIN_DISPATCH`. Returns the lego-standard `HandlerResult`
 * ({ status, body }).
 */

import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult, DbRow } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** A validated suppression target: a single address or a whole domain. */
type SuppressionTarget =
  | { readonly kind: "email"; readonly email: string; readonly domain: string }
  | { readonly kind: "domain"; readonly domain: string };

interface ParsedArgs {
  readonly organizationId: string;
  readonly target: SuppressionTarget;
  readonly reason: string;
  readonly sourceMessageId: string | null;
}

/** Workflow statuses that are still pending — safe to cancel on suppression. */
const CANCELLABLE_STATUSES: readonly string[] = ["draft", "approved", "queued"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Coerce to a trimmed non-empty string, or null. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Interpret the confirm gate. Accepts the boolean `true` or the strings
 * "true"/"yes"/"1" (the bridge may serialize the flag); everything else is
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

/**
 * Validate + normalize the target. An `email` wins over a `domain` when both
 * are supplied. Emails/domains are lower-cased; a leading "@" on a domain is
 * stripped. Returns null when neither is a valid, well-formed value.
 */
function parseTarget(emailRaw: unknown, domainRaw: unknown): SuppressionTarget | null {
  const emailCandidate: string | null = asNonEmptyString(emailRaw);
  if (emailCandidate) {
    const email: string = emailCandidate.toLowerCase();
    if (!EMAIL_RE.test(email)) return null;
    const domain: string = email.split("@")[1] ?? "";
    if (domain.length === 0) return null;
    return { kind: "email", email, domain };
  }

  const domainCandidate: string | null = asNonEmptyString(domainRaw);
  if (domainCandidate) {
    const stripped: string = domainCandidate.toLowerCase().replace(/^@/, "");
    if (!DOMAIN_RE.test(stripped)) return null;
    return { kind: "domain", domain: stripped };
  }

  return null;
}

/** Validate + normalize the agent-supplied args. Returns null on bad input. */
function parseArgs(args: Args): ParsedArgs | null {
  const organizationId: string | null = asNonEmptyString(
    args.organization_id ?? args.organizationId,
  );
  if (!organizationId) return null;

  const target: SuppressionTarget | null = parseTarget(args.email, args.domain);
  if (!target) return null;

  const reason: string = (asNonEmptyString(args.reason) ?? "unspecified").toLowerCase();
  const sourceMessageId: string | null = asNonEmptyString(
    args.source_message_id ?? args.sourceMessageId,
  );

  return { organizationId, target, reason, sourceMessageId };
}

interface SuppressionRow {
  readonly id: string;
  readonly email: string | null;
  readonly domain: string | null;
  readonly reason: string;
  readonly created: boolean;
}

/**
 * Upsert the suppression row, tenant-scoped. Emulates an upsert without an
 * ON CONFLICT target (the table has no unique index on email/domain): try an
 * UPDATE first, and only INSERT when nothing matched. Returns the resulting row
 * and whether it was freshly created.
 */
async function upsertSuppression(
  ctx: HandlerContext,
  parsed: ParsedArgs,
): Promise<SuppressionRow> {
  const { organizationId, target, reason, sourceMessageId } = parsed;
  const email: string | null = target.kind === "email" ? target.email : null;
  const domain: string | null = target.kind === "domain" ? target.domain : null;

  // Match the existing row on the identifying column; the "other" column must be
  // NULL so an email suppression never collides with a domain suppression.
  const matchClause: string =
    target.kind === "email"
      ? "organization_id = $1 AND lower(email) = $2 AND domain IS NULL"
      : "organization_id = $1 AND lower(domain) = $2 AND email IS NULL";
  const matchValue: string = target.kind === "email" ? email! : domain!;

  const updated = await ctx.db.query<DbRow>(
    `UPDATE sdr_suppressions
        SET reason = $3,
            source_message_id = COALESCE($4, source_message_id)
      WHERE ${matchClause}
      RETURNING id, email, domain, reason`,
    organizationId,
    matchValue,
    reason,
    sourceMessageId,
  );

  const existing = updated[0];
  if (existing) {
    return {
      id: String(existing.id),
      email: existing.email === null ? null : String(existing.email),
      domain: existing.domain === null ? null : String(existing.domain),
      reason: String(existing.reason),
      created: false,
    };
  }

  const inserted = await ctx.db.query<DbRow>(
    `INSERT INTO sdr_suppressions
       (id, organization_id, email, domain, reason, source_message_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, email, domain, reason`,
    randomUUID(),
    organizationId,
    email,
    domain,
    reason,
    sourceMessageId,
  );

  const row = inserted[0];
  return {
    id: String(row.id),
    email: row.email === null ? null : String(row.email),
    domain: row.domain === null ? null : String(row.domain),
    reason: String(row.reason),
    created: true,
  };
}

/**
 * Cancel every still-pending outbound touch to the suppressed target. Touches
 * live in `sdr_messages`; the prospect carries the email/domain, so we match via
 * a subquery against `sdr_prospects`. Terminal touches (sent / bounced /
 * cancelled) are left untouched. Returns the number of touches cancelled.
 */
async function cancelPendingTouches(
  ctx: HandlerContext,
  parsed: ParsedArgs,
): Promise<number> {
  const { organizationId, target } = parsed;

  const prospectMatch: string =
    target.kind === "email"
      ? "lower(email) = $3"
      : "(lower(company_domain) = $3 OR lower(split_part(email, '@', 2)) = $3)";
  const matchValue: string = target.kind === "email" ? target.email : target.domain;

  const cancelled = await ctx.db.query<DbRow>(
    `UPDATE sdr_messages
        SET status = 'cancelled',
            next_send_at = NULL,
            updated_at = NOW()
      WHERE organization_id = $1
        AND direction = 'outbound'
        AND status = ANY($2::text[])
        AND prospect_id IN (
          SELECT id FROM sdr_prospects
           WHERE organization_id = $1
             AND ${prospectMatch}
        )
      RETURNING id`,
    organizationId,
    CANCELLABLE_STATUSES,
    matchValue,
  );

  return cancelled.length;
}

export async function handleAddToSuppressionList(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  // Confirm gate first: this is a mutation, so an unconfirmed call never writes.
  if (!isConfirmed(args.confirm)) {
    return {
      status: 412,
      body: "add_to_suppression_list is a confirm-gated mutation; pass confirm=true to execute.",
    };
  }

  const parsed: ParsedArgs | null = parseArgs(args);
  if (!parsed) {
    return {
      status: 400,
      body: "add_to_suppression_list requires organization_id and a valid email or domain.",
    };
  }

  try {
    const suppression: SuppressionRow = await upsertSuppression(ctx, parsed);
    const cancelledTouches: number = await cancelPendingTouches(ctx, parsed);

    // Fire-and-forget: the suppression is already committed, so a bus outage must
    // never surface as a handler failure. Analytics + admin-console audit consume this.
    try {
      await ctx.events.publish("sdr.suppression.added", {
        suppression_id: suppression.id,
        organization_id: parsed.organizationId,
        email: suppression.email,
        domain: suppression.domain,
        reason: suppression.reason,
        source_message_id: parsed.sourceMessageId,
        created: suppression.created,
        cancelled_touches: cancelledTouches,
        source: "agent_tool",
      });
    } catch {
      /* non-fatal: suppression is already persisted */
    }

    return {
      status: 200,
      body: {
        suppressed: true,
        created: suppression.created,
        suppression_id: suppression.id,
        organization_id: parsed.organizationId,
        target: parsed.target.kind === "email"
          ? { email: parsed.target.email }
          : { domain: parsed.target.domain },
        reason: suppression.reason,
        cancelled_touches: cancelledTouches,
      },
    };
  } catch (error: unknown) {
    const message: string =
      error instanceof Error
        ? error.message
        : "Unknown error while adding to suppression list.";
    return {
      status: 500,
      body: `add_to_suppression_list failed: ${message}`,
    };
  }
}
