/**
 * Google Calendar client (F1-008).
 *
 * The booking agent books into the FOUNDER'S OWN Google Calendar so the meeting
 * lands on the calendar they already live in and the prospect gets a real invite
 * from the founder. We talk to the Calendar REST API directly over fetch
 * (freebusy.query to read availability + events.insert with conferenceData to
 * create the event and mint a Google Meet link) rather than pulling in the
 * heavyweight googleapis package. The only input we need is an OAuth access token
 * carrying the calendar scope — the SAME Google connection the founder used to
 * connect their Gmail sending mailbox (sdr_mailboxes.refresh_token), so we reuse
 * refreshGmailAccessToken to mint a fresh access token.
 *
 * Every call is defensive: a missing token / client credentials / HTTP error is
 * returned as a typed failure (never thrown) so the book-meetings cron degrades
 * gracefully instead of 500-ing the whole loop.
 *
 * Server-only (uses fetch + process.env). Never import into a client bundle.
 */

import { refreshGmailAccessToken } from "@/lib/sdr/mailbox-gmail";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const FREEBUSY_URL = `${CALENDAR_BASE}/freeBusy`;

/** A single busy interval returned by freebusy.query. */
export interface BusyInterval {
  start: string; // ISO
  end: string; // ISO
}

export interface FreeBusyResult {
  ok: boolean;
  busy: BusyInterval[];
  error?: string;
}

export interface CalendarEventAttendee {
  email: string;
  displayName?: string | null;
}

export interface CreateEventInput {
  accessToken: string;
  calendarId?: string;
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  timezone: string;
  attendees: CalendarEventAttendee[];
}

export interface CreateEventResult {
  ok: boolean;
  eventId: string | null;
  meetLink: string | null;
  htmlLink: string | null;
  status: number;
  error?: string;
  payload: unknown;
}

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.calendar-google", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Resolve a usable Calendar access token for a connected mailbox. Prefers a
 * still-valid cached access_token; otherwise refreshes from the stored Google
 * refresh token (same OAuth connection as the Gmail sender). Returns null when
 * no credentials are configured — the OAuth-scope lego gap flagged in blockers —
 * which callers treat as "cannot book right now", not an error.
 */
export async function resolveCalendarAccessToken(mailbox: {
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | Date | null;
}): Promise<{ accessToken: string; refreshed: boolean; expiresAt: number | null } | null> {
  const expiresAtMs = mailbox.token_expires_at ? new Date(mailbox.token_expires_at).getTime() : 0;
  if (mailbox.access_token && expiresAtMs > Date.now() + 60_000) {
    return { accessToken: mailbox.access_token, refreshed: false, expiresAt: expiresAtMs || null };
  }
  const refreshed = await refreshGmailAccessToken(mailbox.refresh_token);
  if (!refreshed) return null;
  return { accessToken: refreshed.accessToken, refreshed: true, expiresAt: refreshed.expiresAt };
}

/**
 * Query the founder's calendar for busy intervals in [timeMinIso, timeMaxIso).
 * Returns ok=false (with the busy list defaulting to empty) when the request
 * fails so the slot proposer can fall back to a conservative empty-calendar view
 * rather than silently proposing into a conflict.
 */
export async function queryFreeBusy(params: {
  accessToken: string;
  calendarId?: string;
  timeMinIso: string;
  timeMaxIso: string;
  timezone: string;
}): Promise<FreeBusyResult> {
  const calendarId = params.calendarId || "primary";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(FREEBUSY_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin: params.timeMinIso,
        timeMax: params.timeMaxIso,
        timeZone: params.timezone,
        items: [{ id: calendarId }],
      }),
    });
    const payload = await parseJson(res);
    if (!res.ok) {
      const error =
        (payload as { error?: { message?: string } })?.error?.message || `calendar_http_${res.status}`;
      log("warn", "freebusy_non_ok", { status: res.status, error });
      return { ok: false, busy: [], error };
    }
    const data = payload as {
      calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: unknown[] }>;
    };
    const cal = data.calendars?.[calendarId] ?? Object.values(data.calendars ?? {})[0];
    const busy: BusyInterval[] = (cal?.busy ?? [])
      .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
      .map((b) => ({ start: b.start, end: b.end }));
    return { ok: true, busy };
  } catch (err) {
    const error = String((err as Error).message);
    log("warn", "freebusy_failed", { error });
    return { ok: false, busy: [], error };
  } finally {
    clearTimeout(timeout);
  }
}

/** Pull the Google Meet URL out of an events.insert response's conferenceData. */
function extractMeetLink(payload: unknown): string | null {
  const ev = payload as {
    hangoutLink?: string;
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  } | null;
  if (!ev) return null;
  if (typeof ev.hangoutLink === "string" && ev.hangoutLink) return ev.hangoutLink;
  const entry = (ev.conferenceData?.entryPoints ?? []).find(
    (e) => e.entryPointType === "video" && typeof e.uri === "string",
  );
  return entry?.uri ?? null;
}

/**
 * Create the meeting event on the founder's calendar with a Google Meet link
 * (conferenceData requestId → createRequest) and the prospect as an attendee.
 * conferenceDataVersion=1 is required for Meet link generation.
 */
export async function createCalendarEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const calendarId = input.calendarId || "primary";
  // Deterministic-ish conference request id (no Math.random on the serverless path).
  const requestId = `sdr-${Buffer.from(`${input.startIso}:${input.attendees[0]?.email ?? ""}`)
    .toString("hex")
    .slice(0, 24)}`;
  const url =
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events` +
    `?conferenceDataVersion=1&sendUpdates=all`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.startIso, timeZone: input.timezone },
        end: { dateTime: input.endIso, timeZone: input.timezone },
        attendees: input.attendees.map((a) => ({
          email: a.email,
          displayName: a.displayName ?? undefined,
        })),
        conferenceData: {
          createRequest: {
            requestId,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
        reminders: { useDefault: true },
      }),
    });
    const payload = await parseJson(res);
    if (!res.ok) {
      const error =
        (payload as { error?: { message?: string } })?.error?.message || `calendar_http_${res.status}`;
      log("warn", "event_insert_non_ok", { status: res.status, error });
      return { ok: false, eventId: null, meetLink: null, htmlLink: null, status: res.status, error, payload };
    }
    const data = payload as { id?: string; htmlLink?: string };
    return {
      ok: true,
      eventId: data.id ?? null,
      meetLink: extractMeetLink(payload),
      htmlLink: data.htmlLink ?? null,
      status: res.status,
      payload,
    };
  } catch (err) {
    const error = String((err as Error).message);
    log("warn", "event_insert_failed", { error });
    return { ok: false, eventId: null, meetLink: null, htmlLink: null, status: 0, error, payload: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cancel a calendar event (events.delete). Best-effort — returns ok=false on any
 * failure so a cancellation flow can still mark the DB row cancelled.
 */
export async function deleteCalendarEvent(params: {
  accessToken: string;
  calendarId?: string;
  eventId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const calendarId = params.calendarId || "primary";
  const url =
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/` +
    `${encodeURIComponent(params.eventId)}?sendUpdates=all`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${params.accessToken}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      return { ok: false, error: `calendar_http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}
