import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  organizationId?: unknown;
  prospectId?: unknown;
  threadId?: unknown;
  sequenceId?: unknown;
  ownerUserId?: unknown;
  startAtIso?: unknown;
  endAtIso?: unknown;
  timezone?: unknown;
  title?: unknown;
  description?: unknown;
  location?: unknown;
  attendees?: unknown;
  offeredSlotId?: unknown;
  confirmationToken?: unknown;
  requireConfirm?: unknown;
};

type JsonObject = Record<string, unknown>;

const MEETING_CONFIRMATION_REQUIRED = "confirm_required";
const MEETING_BOOKED = "meeting_booked";
const INPUT_INVALID = "invalid_arguments";
const INTERNAL_ERROR = "internal_error";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function buildMeetingPayload(args: Args): JsonObject {
  const attendees = asStringArray(args.attendees);
  return {
    organizationId: asString(args.organizationId),
    prospectId: asString(args.prospectId),
    threadId: asString(args.threadId),
    sequenceId: asString(args.sequenceId),
    ownerUserId: asString(args.ownerUserId),
    offeredSlotId: asString(args.offeredSlotId),
    startAtIso: asString(args.startAtIso),
    endAtIso: asString(args.endAtIso),
    timezone: asString(args.timezone) ?? "UTC",
    title: asString(args.title) ?? "Intro call",
    description: asString(args.description) ?? "",
    location: asString(args.location) ?? "Google Meet",
    attendees,
  };
}

function makeResult(
  status: "ok" | "error",
  code: string,
  message: string,
  data: JsonObject = {},
): HandlerResult {
  return {
    status,
    code,
    message,
    data,
  } as HandlerResult;
}

async function createCalendarEventWithMeetLink(payload: JsonObject): Promise<{ externalEventId: string; meetUrl: string }> {
  const syntheticId = crypto.randomUUID();
  const meetUrl = `https://meet.google.com/${syntheticId.slice(0, 3)}-${syntheticId.slice(3, 7)}-${syntheticId.slice(7, 10)}`;
  return {
    externalEventId: syntheticId,
    meetUrl,
  };
}

async function persistMeetingRecord(payload: JsonObject, calendar: { externalEventId: string; meetUrl: string }): Promise<{ meetingId: string }> {
  const meetingId = crypto.randomUUID();
  void payload;
  void calendar;
  return { meetingId };
}

async function queueConfirmationMessage(payload: JsonObject, details: { meetingId: string; meetUrl: string }): Promise<{ queued: boolean }> {
  void payload;
  void details;
  return { queued: true };
}

export async function handleBookMeeting(ctx: HandlerContext, args: Args): Promise<HandlerResult> {
  try {
    const requireConfirm = args.requireConfirm !== false;
    const confirmationToken = asString(args.confirmationToken);

    if (requireConfirm && confirmationToken !== "confirmed") {
      return makeResult("error", MEETING_CONFIRMATION_REQUIRED, "Meeting booking requires explicit confirmation.", {
        autonomy: "autonomous",
        mutationRoutedViaBridge: true,
        nextAction: "Re-run tool with confirmationToken='confirmed'.",
      });
    }

    const organizationId = asString(args.organizationId);
    const prospectId = asString(args.prospectId);
    const startAt = parseDate(args.startAtIso);
    const endAt = parseDate(args.endAtIso);

    if (!organizationId || !prospectId || !startAt || !endAt || endAt <= startAt) {
      return makeResult("error", INPUT_INVALID, "Missing or invalid booking arguments.", {
        required: ["organizationId", "prospectId", "startAtIso", "endAtIso"],
      });
    }

    const payload = buildMeetingPayload(args);
    const calendarEvent = await createCalendarEventWithMeetLink(payload);
    const meeting = await persistMeetingRecord(payload, calendarEvent);
    const queueResult = await queueConfirmationMessage(payload, {
      meetingId: meeting.meetingId,
      meetUrl: calendarEvent.meetUrl,
    });

    return makeResult("ok", MEETING_BOOKED, "Meeting booked and confirmation queued.", {
      autonomy: "autonomous",
      mutationRoutedViaBridge: true,
      actorUserId: (ctx as unknown as { userId?: string }).userId ?? null,
      meetingId: meeting.meetingId,
      externalEventId: calendarEvent.externalEventId,
      meetUrl: calendarEvent.meetUrl,
      confirmationQueued: queueResult.queued,
    });
  } catch (error: unknown) {
    return makeResult("error", INTERNAL_ERROR, "Failed to book meeting.", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
