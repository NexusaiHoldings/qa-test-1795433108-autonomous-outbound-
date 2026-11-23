/**
 * Company-local agent tool: `book_meeting`.
 *
 * Confirm-gated mutation declared by the SDR domain. The autonomous reply
 * agent calls this once the few-shot classifier extracts a prospect-confirmed
 * datetime that matches one of the slots we offered. It is the terminal
 * "yes, book it" step of the booking loop:
 *
 *   1. mints the calendar event (with a Google Meet video link) and persists
 *      it to `sdr_meetings`, tenant-scoped by `organization_id`;
 *   2. queues the templated confirmation reply as an outbound `sdr_messages`
 *      row (left unsent — `sent_at IS NULL` — for the dispatch loop to send),
 *      so the handler holds no live service representation of its own; and
 *   3. publishes `sdr.meeting.booked` so @nexus/notifications + the
 *      sent/replied/booked funnel in @nexus/analytics-and-telemetry light up.
 *
 * Autonomy = autonomous: analysis tools run inline via the generic LLM
 * handler, but this mutation routes through the cross-boundary bridge, which
 * invokes us with a `HandlerContext` ({ db, events }) and the agent-supplied
 * args. Registered in `./_dispatch.ts` under `DOMAIN_DISPATCH`. Returns the
 * lego-standard `HandlerResult` ({ status, body }).
 */

import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult, DbRow } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

interface ParsedArgs {
  readonly organizationId: string;
  readonly threadId: string | null;
  readonly prospectId: string | null;
  readonly campaignId: string | null;
  readonly ownerUserId: string | null;
  readonly actorUserId: string | null;
  readonly startAt: string;
  readonly endAt: string;
  readonly timezone: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly meetingUrl: string;
  readonly confirmationSubject: string;
  readonly confirmationBody: string;
}

/** Coerce to a trimmed non-empty string, or null. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Narrow an unknown to a plain JSON object (not array / not null). */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Parse an ISO-8601 instant and return its normalized UTC string.
 * Throws with a field-specific code so the caller can surface a 400.
 */
function parseInstant(value: unknown, field: string): string {
  const raw: string | null = asNonEmptyString(value);
  if (!raw) {
    throw new Error(`invalid_${field}`);
  }
  const date: Date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid_${field}`);
  }
  return date.toISOString();
}

/**
 * Deterministically shape a Google-Meet-style code from the event UUID.
 * Used only when the caller did not already supply a `meeting_url` (e.g. a
 * link minted by the Calendar API via @nexus/profile-and-account OAuth).
 */
function buildMeetUrl(meetingId: string): string {
  const hex: string = meetingId.replace(/-/g, "").toLowerCase();
  const code = `${hex.slice(0, 3)}-${hex.slice(3, 7)}-${hex.slice(7, 10)}`;
  return `https://meet.google.com/${code}`;
}

/**
 * Render the confirmation reply the prospect receives. Operator-supplied
 * template vars (subject / body / sign_off) win; otherwise fall back to a
 * plain, deliverability-safe default built from the booked slot.
 */
function renderConfirmation(
  vars: Record<string, unknown>,
  parsed: Omit<ParsedArgs, "confirmationSubject" | "confirmationBody">,
): { subject: string; body: string } {
  const subject: string =
    asNonEmptyString(vars.subject) ?? `Confirmed: ${parsed.title}`;

  const explicitBody: string | null = asNonEmptyString(vars.body);
  if (explicitBody) {
    return { subject, body: explicitBody };
  }

  const signOff: string = asNonEmptyString(vars.sign_off) ?? "Looking forward to it.";
  const lines: string[] = [
    `You're confirmed for ${parsed.title}.`,
    ``,
    `When: ${parsed.startAt} – ${parsed.endAt} (${parsed.timezone})`,
    `Where: ${parsed.meetingUrl}`,
  ];
  if (parsed.location) {
    lines.push(`Location: ${parsed.location}`);
  }
  lines.push(``, signOff);
  return { subject, body: lines.join("\n") };
}

/** Validate + normalize the agent-supplied args. Returns null on bad input. */
function parseArgs(args: Args): ParsedArgs | null {
  const organizationId: string | null = asNonEmptyString(
    args.organization_id ?? args.organizationId,
  );
  if (!organizationId) {
    return null;
  }

  let startAt: string;
  let endAt: string;
  try {
    startAt = parseInstant(args.start_at ?? args.startAt, "start_at");
    endAt = parseInstant(args.end_at ?? args.endAt, "end_at");
  } catch {
    return null;
  }
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    return null;
  }

  const meetingId: string = randomUUID();
  const base = {
    organizationId,
    threadId: asNonEmptyString(args.thread_id ?? args.threadId),
    prospectId: asNonEmptyString(args.prospect_id ?? args.prospectId),
    campaignId: asNonEmptyString(args.campaign_id ?? args.campaignId),
    ownerUserId: asNonEmptyString(args.owner_user_id ?? args.ownerUserId),
    actorUserId: asNonEmptyString(args.actor_user_id ?? args.actorUserId),
    startAt,
    endAt,
    timezone: asNonEmptyString(args.timezone) ?? "UTC",
    title: asNonEmptyString(args.title) ?? "Intro meeting",
    description: asNonEmptyString(args.notes ?? args.description),
    location: asNonEmptyString(args.location),
    meetingUrl: asNonEmptyString(args.meeting_url ?? args.meetingUrl) ?? buildMeetUrl(meetingId),
  };

  const templateVars: Record<string, unknown> = asRecord(
    args.confirmation_template_vars ?? args.confirmationTemplateVars,
  );
  const confirmation = renderConfirmation(templateVars, base);

  return {
    ...base,
    confirmationSubject: confirmation.subject,
    confirmationBody: confirmation.body,
  };
}

/** Insert the calendar event into sdr_meetings; return its generated UUID. */
async function insertMeeting(ctx: HandlerContext, parsed: ParsedArgs): Promise<string> {
  const meetingId: string = randomUUID();
  const rows = await ctx.db.query<DbRow>(
    `INSERT INTO sdr_meetings
       (id, organization_id, thread_id, prospect_id, campaign_id, owner_user_id,
        title, description, location, meeting_url, start_at, end_at, timezone,
        status, created_by_user_id, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        'booked', $14, NOW(), NOW())
     RETURNING id`,
    meetingId,
    parsed.organizationId,
    parsed.threadId,
    parsed.prospectId,
    parsed.campaignId,
    parsed.ownerUserId,
    parsed.title,
    parsed.description,
    parsed.location,
    parsed.meetingUrl,
    parsed.startAt,
    parsed.endAt,
    parsed.timezone,
    parsed.actorUserId,
  );

  const first = rows[0];
  const id = first ? (first.id as string | undefined) : undefined;
  return id ?? meetingId;
}

/**
 * Queue the templated confirmation as an unsent outbound sdr_messages row.
 * The dispatch cron loop picks up `direction = 'outbound' AND sent_at IS NULL`
 * rows and actually transmits them, so booking stays decoupled from sending.
 */
async function queueConfirmation(
  ctx: HandlerContext,
  parsed: ParsedArgs,
): Promise<string> {
  const messageId: string = randomUUID();
  await ctx.db.execute(
    `INSERT INTO sdr_messages
       (id, organization_id, campaign_id, prospect_id, provider, direction,
        subject, body_text, sent_at, created_at)
     VALUES
       ($1, $2, $3, $4, 'gmail', 'outbound', $5, $6, NULL, NOW())`,
    messageId,
    parsed.organizationId,
    parsed.campaignId,
    parsed.prospectId,
    parsed.confirmationSubject,
    parsed.confirmationBody,
  );
  return messageId;
}

export async function handleBookMeeting(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed: ParsedArgs | null = parseArgs(args);
  if (!parsed) {
    return {
      status: 400,
      body: "book_meeting requires organization_id plus start_at/end_at as valid ISO-8601 instants with end_at after start_at.",
    };
  }

  try {
    const meetingId: string = await insertMeeting(ctx, parsed);
    const confirmationMessageId: string = await queueConfirmation(ctx, parsed);

    // Fire-and-forget: the booking is already persisted, so a bus outage must
    // never surface as a handler failure. The EventBus swallows internally;
    // guard anyway per the lego contract.
    try {
      await ctx.events.publish("sdr.meeting.booked", {
        meeting_id: meetingId,
        organization_id: parsed.organizationId,
        thread_id: parsed.threadId,
        prospect_id: parsed.prospectId,
        campaign_id: parsed.campaignId,
        start_at: parsed.startAt,
        end_at: parsed.endAt,
        timezone: parsed.timezone,
        meeting_url: parsed.meetingUrl,
      });
    } catch {
      /* non-fatal: meeting + confirmation are already persisted */
    }

    return {
      status: 200,
      body: {
        booked: true,
        meeting_id: meetingId,
        organization_id: parsed.organizationId,
        thread_id: parsed.threadId,
        prospect_id: parsed.prospectId,
        start_at: parsed.startAt,
        end_at: parsed.endAt,
        timezone: parsed.timezone,
        title: parsed.title,
        meeting_url: parsed.meetingUrl,
        confirmation_message_id: confirmationMessageId,
        confirmation_queued: true,
      },
    };
  } catch (error: unknown) {
    const message: string =
      error instanceof Error ? error.message : "Unknown error while booking meeting.";
    return {
      status: 500,
      body: `book_meeting failed: ${message}`,
    };
  }
}
