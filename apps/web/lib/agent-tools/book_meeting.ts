import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { sql } from "@vercel/postgres";
import { randomUUID } from "node:crypto";

export type Args = {
  organization_id?: unknown;
  thread_id?: unknown;
  prospect_id?: unknown;
  owner_user_id?: unknown;
  start_at?: unknown;
  end_at?: unknown;
  timezone?: unknown;
  title?: unknown;
  notes?: unknown;
  location?: unknown;
  meeting_url?: unknown;
  confirmation_template_id?: unknown;
  confirmation_template_vars?: unknown;
  actor_user_id?: unknown;
};

type NormalizedArgs = {
  organizationId: string;
  threadId: string | null;
  prospectId: string | null;
  ownerUserId: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  title: string;
  notes: string | null;
  location: string | null;
  meetingUrl: string;
  confirmationTemplateId: string | null;
  confirmationTemplateVars: Record<string, unknown>;
  actorUserId: string | null;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const parseIso = (value: unknown, field: string): Date => {
  if (!isNonEmptyString(value)) {
    throw new Error(`invalid_${field}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid_${field}`);
  }
  return date;
};

const buildMeetUrl = (organizationId: string, meetingId: string): string =>
  `https://meet.google.com/${organizationId.slice(0, 3)}-${meetingId.slice(0, 3)}-${meetingId.slice(3, 6)}`;

const normalizeArgs = (args: Args): NormalizedArgs => {
  if (!isNonEmptyString(args.organization_id)) {
    throw new Error("invalid_organization_id");
  }

  const start = parseIso(args.start_at, "start_at");
  const end = parseIso(args.end_at, "end_at");

  if (end.getTime() <= start.getTime()) {
    throw new Error("invalid_time_range");
  }

  const meetingId = randomUUID();

  return {
    organizationId: args.organization_id,
    threadId: isNonEmptyString(args.thread_id) ? args.thread_id : null,
    prospectId: isNonEmptyString(args.prospect_id) ? args.prospect_id : null,
    ownerUserId: isNonEmptyString(args.owner_user_id) ? args.owner_user_id : null,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    timezone: isNonEmptyString(args.timezone) ? args.timezone : "UTC",
    title: isNonEmptyString(args.title) ? args.title.trim() : "Intro meeting",
    notes: isNonEmptyString(args.notes) ? args.notes.trim() : null,
    location: isNonEmptyString(args.location) ? args.location.trim() : null,
    meetingUrl: isNonEmptyString(args.meeting_url)
      ? args.meeting_url.trim()
      : buildMeetUrl(args.organization_id, meetingId),
    confirmationTemplateId: isNonEmptyString(args.confirmation_template_id)
      ? args.confirmation_template_id
      : null,
    confirmationTemplateVars: asRecord(args.confirmation_template_vars),
    actorUserId: isNonEmptyString(args.actor_user_id) ? args.actor_user_id : null,
  };
};

export const handleBookMeeting = async (
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> => {
  try {
    const normalized = normalizeArgs(args);
    const meetingId = randomUUID();

    await sql`
      INSERT INTO sdr_meetings (
        id,
        organization_id,
        thread_id,
        prospect_id,
        owner_user_id,
        start_at,
        end_at,
        timezone,
        title,
        notes,
        location,
        meeting_url,
        created_by,
        created_at,
        updated_at
      )
      VALUES (
        ${meetingId},
        ${normalized.organizationId},
        ${normalized.threadId},
        ${normalized.prospectId},
        ${normalized.ownerUserId},
        ${normalized.startAt},
        ${normalized.endAt},
        ${normalized.timezone},
        ${normalized.title},
        ${normalized.notes},
        ${normalized.location},
        ${normalized.meetingUrl},
        ${normalized.actorUserId ?? null},
        NOW(),
        NOW()
      )
    `;

    const queueId = randomUUID();

    await sql`
      INSERT INTO sdr_message_queue (
        id,
        organization_id,
        thread_id,
        prospect_id,
        kind,
        status,
        template_id,
        template_vars,
        scheduled_at,
        dedupe_key,
        created_by,
        created_at,
        updated_at
      )
      VALUES (
        ${queueId},
        ${normalized.organizationId},
        ${normalized.threadId},
        ${normalized.prospectId},
        'meeting_confirmation',
        'queued',
        ${normalized.confirmationTemplateId},
        ${JSON.stringify({
          ...normalized.confirmationTemplateVars,
          meeting_id: meetingId,
          start_at: normalized.startAt,
          end_at: normalized.endAt,
          timezone: normalized.timezone,
          title: normalized.title,
          meeting_url: normalized.meetingUrl,
        })},
        NOW(),
        ${`meeting_confirmation:${normalized.organizationId}:${meetingId}`},
        ${normalized.actorUserId ?? null},
        NOW(),
        NOW()
      )
    `;

    return {
      ok: true,
      autonomy: "autonomous",
      data: {
        meeting_id: meetingId,
        organization_id: normalized.organizationId,
        start_at: normalized.startAt,
        end_at: normalized.endAt,
        timezone: normalized.timezone,
        title: normalized.title,
        meeting_url: normalized.meetingUrl,
        queue_id: queueId,
      },
      meta: {
        tool: "book_meeting",
        bridge: "cross-boundary",
        actor_user_id: normalized.actorUserId ?? null,
        ctx_present: Boolean(ctx),
      },
    } as HandlerResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "book_meeting_failed";
    return {
      ok: false,
      error: {
        code: "book_meeting_failed",
        message,
      },
      autonomy: "autonomous",
      meta: {
        tool: "book_meeting",
      },
    } as HandlerResult;
  }
};
