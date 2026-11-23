/**
 * Slot proposer (F1-008).
 *
 * When a prospect says "yes, let's talk" (classified interested → prospect moved
 * to booking_requested by the conversation engine), this module reads the
 * founder's Google Calendar freebusy for the next 5 BUSINESS DAYS, carves the
 * open business-hours windows into 30-minute candidate slots, picks THREE spread
 * across different days, and sends a short reply offering them in the PROSPECT'S
 * OWN timezone from the founder's mailbox. It records an sdr_meetings row in the
 * `proposed` state (holding the offered slots) so the book pass can match the
 * prospect's confirmation back to a proposal.
 *
 * Timezone handling is dependency-free: slots are generated as local wall-clock
 * business hours in the prospect's zone and converted to the correct UTC instant
 * via Intl offset math, so a 10:00 slot is 10:00 for the prospect regardless of
 * where the founder (or the server) sits.
 *
 * Server-only (fetch, pg, Buffer). Never import into a client bundle.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";
import {
  queryFreeBusy,
  resolveCalendarAccessToken,
  type BusyInterval,
} from "@/lib/sdr/calendar-google";
import { buildRawMessage, sendGmailMessage, fetchGmailMessageMeta } from "@/lib/sdr/mailbox-gmail";

/** Meeting length in minutes. */
export const SLOT_MINUTES = 30;
/** How many business days ahead to scan. */
export const BUSINESS_DAYS = 5;
/** Local business-hour start times (24h) we offer slots at, earliest first. */
export const SLOT_HOURS = [10, 13, 15];
/** How many slots to offer the prospect. */
export const SLOT_COUNT = 3;

const DEFAULT_TIMEZONE = process.env.SDR_DEFAULT_TIMEZONE || "America/New_York";

/** Coarse country-code → IANA timezone map for the prospect's local time. */
const COUNTRY_TIMEZONE: Record<string, string> = {
  US: "America/New_York",
  CA: "America/Toronto",
  GB: "Europe/London",
  UK: "Europe/London",
  IE: "Europe/Dublin",
  FR: "Europe/Paris",
  DE: "Europe/Berlin",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  SE: "Europe/Stockholm",
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
  IN: "Asia/Kolkata",
  SG: "Asia/Singapore",
  JP: "Asia/Tokyo",
  BR: "America/Sao_Paulo",
  MX: "America/Mexico_City",
};

export interface ProspectForBooking {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  email: string;
  first_name: string | null;
  full_name: string | null;
  company_name: string | null;
  title: string | null;
  country_code: string | null;
  region: string | null;
  timezone?: string | null;
}

export interface MailboxForBooking {
  id: string;
  email: string;
  display_name: string | null;
  domain: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | Date | null;
}

export interface ProposedSlot {
  startIso: string;
  endIso: string;
  /** Human label in the prospect's timezone, e.g. "Tue, Nov 25 · 10:00 AM EST". */
  label: string;
}

export interface ProposeResult {
  ok: boolean;
  meetingId: string | null;
  slots: ProposedSlot[];
  messageId: string | null;
  sent: boolean;
  reason?: string;
}

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.slot-proposer", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timezone math (dependency-free, via Intl)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the IANA timezone to use for a prospect. */
export function resolveTimezone(prospect: Pick<ProspectForBooking, "timezone" | "country_code">): string {
  const explicit = (prospect.timezone || "").trim();
  if (explicit && isValidTimezone(explicit)) return explicit;
  const cc = (prospect.country_code || "").trim().toUpperCase();
  if (cc && COUNTRY_TIMEZONE[cc]) return COUNTRY_TIMEZONE[cc];
  return DEFAULT_TIMEZONE;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of a timezone at a given UTC instant: tzLocalWallClock - utc. */
function timezoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asUtc - utcMs;
}

/** Convert a wall-clock time in a timezone to the corresponding UTC Date. */
export function zonedWallClockToUtc(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month1 - 1, day, hour, minute, 0);
  // One correction pass resolves the offset for standard business-hour slots.
  const offset = timezoneOffsetMs(guess, timeZone);
  let utc = guess - offset;
  // Refine once more in case the first guess straddled a DST boundary.
  const offset2 = timezoneOffsetMs(utc, timeZone);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

/** The Y/M/D and weekday a UTC instant maps to in a timezone. */
function zonedCalendarParts(utcMs: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: weekdays[map.weekday] ?? 1,
  };
}

/** Pretty label for a slot in the prospect's timezone. */
export function formatSlotLabel(utcIso: string, timeZone: string): string {
  const d = new Date(utcIso);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
  return `${day} · ${time}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot computation
// ─────────────────────────────────────────────────────────────────────────────

function overlapsBusy(startMs: number, endMs: number, busy: BusyInterval[]): boolean {
  for (const b of busy) {
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    if (Number.isNaN(bs) || Number.isNaN(be)) continue;
    if (startMs < be && endMs > bs) return true;
  }
  return false;
}

/**
 * Build up to SLOT_COUNT open slots over the next BUSINESS_DAYS business days in
 * the prospect's timezone, skipping weekends, past times, and busy intervals.
 * Picks at most one slot per day first (to spread options across days) before
 * backfilling a second slot on earlier days if needed.
 */
export function computeSlots(params: {
  nowMs: number;
  timeZone: string;
  busy: BusyInterval[];
}): ProposedSlot[] {
  const { nowMs, timeZone, busy } = params;
  const minStart = nowMs + 60 * 60_000; // never offer a slot <1h out
  const byDay: ProposedSlot[][] = [];

  let businessDaysSeen = 0;
  // Walk forward day-by-day (in the prospect's zone) up to 14 calendar days to
  // collect BUSINESS_DAYS business days of candidate slots.
  for (let dayOffset = 0; dayOffset < 14 && businessDaysSeen < BUSINESS_DAYS; dayOffset++) {
    const probe = nowMs + dayOffset * 24 * 60 * 60_000;
    const cal = zonedCalendarParts(probe, timeZone);
    if (cal.weekday === 0 || cal.weekday === 6) continue; // skip weekends
    businessDaysSeen++;

    const daySlots: ProposedSlot[] = [];
    for (const hour of SLOT_HOURS) {
      const start = zonedWallClockToUtc(cal.year, cal.month, cal.day, hour, 0, timeZone);
      const startMs = start.getTime();
      const endMs = startMs + SLOT_MINUTES * 60_000;
      if (startMs < minStart) continue;
      if (overlapsBusy(startMs, endMs, busy)) continue;
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();
      daySlots.push({ startIso, endIso, label: formatSlotLabel(startIso, timeZone) });
    }
    if (daySlots.length) byDay.push(daySlots);
  }

  // First pass: one slot per day (spread). Second pass: backfill extras in order.
  const picked: ProposedSlot[] = [];
  for (const day of byDay) {
    if (picked.length >= SLOT_COUNT) break;
    picked.push(day[0]);
  }
  for (const day of byDay) {
    for (let i = 1; i < day.length && picked.length < SLOT_COUNT; i++) {
      picked.push(day[i]);
    }
  }
  // Keep chronological order for the reply.
  return picked.sort((a, b) => a.startIso.localeCompare(b.startIso)).slice(0, SLOT_COUNT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread + message helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ThreadHead {
  thread_ref: string | null;
  rfc822_message_id: string | null;
  subject: string | null;
}

async function latestThreadHead(organizationId: string, prospectId: string): Promise<ThreadHead | null> {
  const db = buildDb();
  const rows = await db.query<ThreadHead>(
    `SELECT thread_ref, rfc822_message_id, subject
       FROM sdr_messages
      WHERE organization_id = $1 AND prospect_id = $2 AND direction = 'outbound'
        AND thread_ref IS NOT NULL
      ORDER BY COALESCE(sent_at, created_at) DESC
      LIMIT 1`,
    organizationId,
    prospectId,
  );
  return rows[0] ?? null;
}

function firstName(prospect: ProspectForBooking): string {
  if (prospect.first_name && prospect.first_name.trim()) return prospect.first_name.trim();
  const full = (prospect.full_name || "").trim();
  if (full) return full.split(/\s+/)[0];
  const local = prospect.email.split("@")[0] || "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** Compose the slot-offer reply. Times only — no pricing / service terms. */
export function composeProposalBody(prospect: ProspectForBooking, slots: ProposedSlot[], tz: string): string {
  const name = firstName(prospect);
  const lines = slots.map((s) => `  • ${s.label}`);
  return (
    `Hi ${name},\n\n` +
    `Great — happy to find time. Here are a few options (times shown in your local timezone, ${tz}):\n\n` +
    `${lines.join("\n")}\n\n` +
    `Just reply with whichever works and I'll send a calendar invite with a video link. ` +
    `If none of these fit, let me know a couple of windows that do and I'll make it work.\n\n` +
    `Best,`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface ProposeInput {
  prospect: ProspectForBooking;
  mailbox: MailboxForBooking | null;
  replyId: string | null;
  nowMs: number;
}

/**
 * Propose three slots to a prospect and record the proposal. Idempotent at the
 * caller level (the unique partial index on sdr_meetings prevents a second active
 * meeting per prospect). Never throws — returns a typed result the cron logs.
 */
export async function proposeMeeting(input: ProposeInput): Promise<ProposeResult> {
  const { prospect, mailbox, replyId, nowMs } = input;
  const db = buildDb();
  const tz = resolveTimezone(prospect);

  // Resolve a Google token (used for BOTH freebusy and the Gmail send — same
  // founder OAuth connection). Without it we still propose generic open slots.
  let accessToken: string | null = null;
  let busy: BusyInterval[] = [];
  if (mailbox) {
    const tok = await resolveCalendarAccessToken(mailbox);
    accessToken = tok?.accessToken ?? null;
    if (accessToken) {
      const timeMin = new Date(nowMs).toISOString();
      const timeMax = new Date(nowMs + 16 * 24 * 60 * 60_000).toISOString();
      const fb = await queryFreeBusy({ accessToken, timeMinIso: timeMin, timeMaxIso: timeMax, timezone: tz });
      if (fb.ok) busy = fb.busy;
    }
  }

  const slots = computeSlots({ nowMs, timeZone: tz, busy });
  if (slots.length === 0) {
    log("warn", "no_slots_available", { prospectId: prospect.id });
    return { ok: false, meetingId: null, slots: [], messageId: null, sent: false, reason: "no_slots" };
  }

  const head = await latestThreadHead(prospect.organization_id, prospect.id);
  const subject = head?.subject ? ensureReplyPrefix(head.subject) : "Re: finding a time to talk";
  const body = composeProposalBody(prospect, slots, tz);

  // Send the proposal from the founder's mailbox (threaded into the conversation).
  let sent = false;
  let providerMessageId: string | null = null;
  let threadRef: string | null = head?.thread_ref ?? null;
  let rfc822: string | null = null;
  if (accessToken && mailbox) {
    const { raw, messageId } = buildRawMessage({
      from: mailbox.email,
      fromName: mailbox.display_name,
      to: prospect.email,
      toName: prospect.full_name,
      subject,
      bodyText: body,
      inReplyTo: head?.rfc822_message_id ?? null,
      references: head?.rfc822_message_id ?? null,
    });
    rfc822 = messageId;
    const res = await sendGmailMessage({ accessToken, raw, threadId: threadRef ?? undefined });
    if (res.ok) {
      sent = true;
      providerMessageId = res.providerMessageId;
      threadRef = res.threadId ?? threadRef;
      if (res.providerMessageId) {
        const meta = await fetchGmailMessageMeta({ accessToken, providerMessageId: res.providerMessageId });
        if (meta.rfc822MessageId) rfc822 = meta.rfc822MessageId;
      }
    } else {
      log("warn", "proposal_send_failed", { prospectId: prospect.id, error: res.error });
    }
  }

  // Record the outbound message.
  const messageRowId = randomUUID();
  await db.execute(
    `INSERT INTO sdr_messages
       (id, organization_id, campaign_id, prospect_id, provider, provider_message_id,
        direction, subject, body_text, touch_index, status, sent_at, thread_ref,
        rfc822_message_id, sent_mailbox_id, signal_citations)
     VALUES ($1, $2, $3, $4, 'gmail', $5,
        'outbound', $6, $7, 0, $8, $9, $10, $11, $12, '[]'::jsonb)`,
    messageRowId,
    prospect.organization_id,
    prospect.campaign_id,
    prospect.id,
    providerMessageId,
    subject,
    body,
    sent ? "sent" : "draft",
    sent ? new Date(nowMs).toISOString() : null,
    threadRef,
    rfc822,
    mailbox?.id ?? null,
  );

  // Record the proposed meeting.
  const meetingId = randomUUID();
  await db.execute(
    `INSERT INTO sdr_meetings
       (id, organization_id, prospect_id, reply_id, campaign_id, mailbox_id,
        timezone, status, proposed_slots, proposal_message_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed', $8::jsonb, $9, NOW(), NOW())`,
    meetingId,
    prospect.organization_id,
    prospect.id,
    replyId,
    prospect.campaign_id,
    mailbox?.id ?? null,
    tz,
    JSON.stringify(slots),
    messageRowId,
  );

  log("info", "slots_proposed", { prospectId: prospect.id, meetingId, slotCount: slots.length, sent });
  return { ok: true, meetingId, slots, messageId: messageRowId, sent };
}

function ensureReplyPrefix(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
