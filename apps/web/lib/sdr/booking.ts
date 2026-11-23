/**
 * Booking engine (F1-008).
 *
 * The handoff point buyers actually want: the founder takes over ONLY once a
 * meeting is truly booked. This module owns the two state transitions of the
 * book-meetings loop:
 *
 *   1. proposed  — a prospect said yes (booking_requested) and has no active
 *                  meeting → slot-proposer offers three freebusy-clear slots.
 *   2. confirmed — the prospect picked a time (the classifier extracted the
 *                  datetime from their reply) → we create the event on the
 *                  founder's Google Calendar WITH a Meet link, send a templated
 *                  confirmation containing ONLY date, time, and link (never
 *                  service terms or pricing — liability_assessor human-in-loop),
 *                  compose + store the pre-meeting brief, and fire the
 *                  booked-meeting notification + referral prompt.
 *
 * runBookMeetings() is the orchestrator the Vercel cron calls; it also runs the
 * 12-hours-before brief delivery pass. Every step is defensive and scoped by
 * organization_id; parameterized SQL only.
 *
 * Server-only (fetch, pg, Buffer). Never import into a client bundle.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import {
  createCalendarEvent,
  resolveCalendarAccessToken,
  type CreateEventResult,
} from "@/lib/sdr/calendar-google";
import { buildRawMessage, sendGmailMessage, fetchGmailMessageMeta } from "@/lib/sdr/mailbox-gmail";
import {
  proposeMeeting,
  formatSlotLabel,
  SLOT_MINUTES,
  type ProspectForBooking,
  type MailboxForBooking,
} from "@/lib/sdr/slot-proposer";
import { generateAndStoreBrief, deliverBrief } from "@/lib/sdr/meeting-brief";

const MAILBOX_COLUMNS =
  "id, email, display_name, domain, access_token, refresh_token, token_expires_at";
const PROSPECT_COLUMNS =
  "id, organization_id, campaign_id, email, first_name, full_name, company_name, title, country_code, region";

/** Deliver the brief this many ms before the meeting. */
const BRIEF_LEAD_MS = 12 * 60 * 60_000;

export interface BookingSummary {
  orgsProcessed: number;
  proposed: number;
  booked: number;
  briefsDelivered: number;
  skipped: number;
  errors: number;
}

interface MeetingRow {
  id: string;
  organization_id: string;
  prospect_id: string | null;
  campaign_id: string | null;
  mailbox_id: string | null;
  timezone: string;
  status: string;
  starts_at: string | Date | null;
  created_at: string | Date;
}

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.booking", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function firstName(prospect: ProspectForBooking): string {
  if (prospect.first_name && prospect.first_name.trim()) return prospect.first_name.trim();
  const full = (prospect.full_name || "").trim();
  if (full) return full.split(/\s+/)[0];
  const local = prospect.email.split("@")[0] || "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function ensureReplyPrefix(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Templated booking confirmation. Deliberately minimal: date, time (prospect tz),
 * and the video link ONLY. No pricing, no service terms — those require a human
 * in the loop (liability_assessor.human_in_loop_required_for[4]).
 */
export function composeConfirmationBody(
  prospect: ProspectForBooking,
  startIso: string,
  timezone: string,
  meetLink: string | null,
): string {
  const name = firstName(prospect);
  const when = formatSlotLabel(startIso, timezone);
  const link = meetLink
    ? `Video link: ${meetLink}`
    : "A calendar invite with the video link is on its way to your inbox.";
  return (
    `Hi ${name},\n\n` +
    `You're all set — I've put us on the calendar:\n\n` +
    `  ${when}\n\n` +
    `${link}\n\n` +
    `I've sent a calendar invite so it's easy to find. Looking forward to it!\n\n` +
    `Best,`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Data loading helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadMailbox(organizationId: string): Promise<MailboxForBooking | null> {
  const db = buildDb();
  const rows = await db.query<MailboxForBooking>(
    `SELECT ${MAILBOX_COLUMNS} FROM sdr_mailboxes
      WHERE organization_id = $1 AND status = 'connected'
      ORDER BY created_at ASC LIMIT 1`,
    organizationId,
  );
  return rows[0] ?? null;
}

async function loadProspect(organizationId: string, prospectId: string): Promise<ProspectForBooking | null> {
  const db = buildDb();
  const rows = await db.query<ProspectForBooking>(
    `SELECT ${PROSPECT_COLUMNS} FROM sdr_prospects
      WHERE organization_id = $1 AND id = $2 LIMIT 1`,
    organizationId,
    prospectId,
  );
  return rows[0] ?? null;
}

/** Latest confirming reply (carries extracted_datetime) newer than a timestamp. */
async function latestConfirmingReply(
  organizationId: string,
  prospectId: string,
  afterIso: string,
): Promise<{ id: string; extracted_datetime: string | Date } | null> {
  const db = buildDb();
  const rows = await db.query<{ id: string; extracted_datetime: string | Date }>(
    `SELECT id, extracted_datetime
       FROM sdr_replies
      WHERE organization_id = $1 AND prospect_id = $2
        AND extracted_datetime IS NOT NULL
        AND received_at >= $3
      ORDER BY received_at DESC LIMIT 1`,
    organizationId,
    prospectId,
    afterIso,
  );
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Book a confirmed meeting
// ─────────────────────────────────────────────────────────────────────────────

export interface BookInput {
  meeting: MeetingRow;
  prospect: ProspectForBooking;
  mailbox: MailboxForBooking | null;
  replyId: string;
  startIso: string;
  nowMs: number;
}

export interface BookResult {
  ok: boolean;
  meetingId: string;
  calendarEventId: string | null;
  meetLink: string | null;
  reason?: string;
}

/**
 * Create the calendar event + Meet link, send the minimal confirmation, store the
 * pre-meeting brief, and fire the booked/referral events. Never throws.
 */
export async function bookMeeting(input: BookInput): Promise<BookResult> {
  const { meeting, prospect, mailbox, replyId, startIso, nowMs } = input;
  const db = buildDb();
  const tz = meeting.timezone || "UTC";
  const startMs = new Date(startIso).getTime();

  if (Number.isNaN(startMs) || startMs < nowMs - 60_000) {
    log("warn", "confirmed_time_invalid_or_past", { meetingId: meeting.id, startIso });
    await db.execute(
      `UPDATE sdr_meetings SET last_error = 'confirmed_time_in_past', updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      meeting.organization_id,
      meeting.id,
    );
    return { ok: false, meetingId: meeting.id, calendarEventId: null, meetLink: null, reason: "past_time" };
  }

  const endIso = new Date(startMs + SLOT_MINUTES * 60_000).toISOString();
  const companyName = process.env.COMPANY_NAME || mailbox?.display_name || "our team";
  const prospectCompany = prospect.company_name || prospect.full_name || prospect.email;

  // 1. Create the calendar event (with Meet link) if we have a founder token.
  let event: CreateEventResult | null = null;
  let accessToken: string | null = null;
  if (mailbox) {
    const tok = await resolveCalendarAccessToken(mailbox);
    accessToken = tok?.accessToken ?? null;
    if (accessToken) {
      event = await createCalendarEvent({
        accessToken,
        summary: `Intro call: ${companyName} <> ${prospectCompany}`,
        description:
          `Intro conversation booked by your SDR agent.\n\n` +
          `Attendee: ${prospect.full_name || prospect.email} (${prospect.email})`,
        startIso,
        endIso,
        timezone: tz,
        attendees: [{ email: prospect.email, displayName: prospect.full_name }],
      });
      if (!event.ok) {
        log("warn", "calendar_event_failed", { meetingId: meeting.id, error: event.error });
      }
    }
  }

  const calendarEventId = event?.ok ? event.eventId : null;
  const meetLink = event?.ok ? event.meetLink : null;

  // 2. Send the minimal confirmation from the founder's mailbox.
  const head = await db.query<{ thread_ref: string | null; rfc822_message_id: string | null; subject: string | null }>(
    `SELECT thread_ref, rfc822_message_id, subject
       FROM sdr_messages
      WHERE organization_id = $1 AND prospect_id = $2 AND direction = 'outbound'
        AND thread_ref IS NOT NULL
      ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`,
    meeting.organization_id,
    prospect.id,
  );
  const threadHead = head[0] ?? null;
  const subject = threadHead?.subject ? ensureReplyPrefix(threadHead.subject) : "Re: you're booked";
  const body = composeConfirmationBody(prospect, startIso, tz, meetLink);

  let sent = false;
  let providerMessageId: string | null = null;
  let threadRef: string | null = threadHead?.thread_ref ?? null;
  let rfc822: string | null = null;
  if (accessToken && mailbox) {
    const { raw, messageId } = buildRawMessage({
      from: mailbox.email,
      fromName: mailbox.display_name,
      to: prospect.email,
      toName: prospect.full_name,
      subject,
      bodyText: body,
      inReplyTo: threadHead?.rfc822_message_id ?? null,
      references: threadHead?.rfc822_message_id ?? null,
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
      log("warn", "confirmation_send_failed", { meetingId: meeting.id, error: res.error });
    }
  }

  const confirmationId = randomUUID();
  await db.execute(
    `INSERT INTO sdr_messages
       (id, organization_id, campaign_id, prospect_id, provider, provider_message_id,
        direction, subject, body_text, touch_index, status, sent_at, thread_ref,
        rfc822_message_id, sent_mailbox_id, signal_citations)
     VALUES ($1, $2, $3, $4, 'gmail', $5,
        'outbound', $6, $7, 0, $8, $9, $10, $11, $12, '[]'::jsonb)`,
    confirmationId,
    meeting.organization_id,
    meeting.campaign_id,
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

  // 3. Flip the meeting to confirmed.
  await db.execute(
    `UPDATE sdr_meetings
        SET status = 'confirmed', starts_at = $3, ends_at = $4,
            calendar_event_id = $5, meet_link = $6, reply_id = $7,
            confirmation_message_id = $8, last_error = NULL, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    meeting.organization_id,
    meeting.id,
    startIso,
    endIso,
    calendarEventId,
    meetLink,
    replyId,
    confirmationId,
  );

  // 4. Mark the prospect booked.
  await db.execute(
    `UPDATE sdr_prospects SET status = 'meeting_booked', updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    meeting.organization_id,
    prospect.id,
  );

  // 5. Compose + store the pre-meeting brief (delivered 12h before by the cron).
  try {
    await generateAndStoreBrief({
      organizationId: meeting.organization_id,
      meetingId: meeting.id,
      prospect,
      startIso,
      timezone: tz,
      nowMs,
    });
  } catch (err) {
    log("warn", "brief_generate_failed", { meetingId: meeting.id, error: String((err as Error).message) });
  }

  // 6. Fire the booked-meeting notification + referral prompt (fire-and-forget).
  await emitBookedEvents({
    meeting,
    prospect,
    startIso,
    timezone: tz,
    meetLink,
    nowMs,
  });

  log("info", "meeting_booked", {
    meetingId: meeting.id,
    prospectId: prospect.id,
    startIso,
    calendarEventId,
    sent,
  });
  return { ok: true, meetingId: meeting.id, calendarEventId, meetLink };
}

/**
 * Publish sdr.meeting.booked (consumed by @nexus/notifications for the founder
 * alert + @nexus/analytics-and-telemetry for the booked funnel event) and
 * sdr.referral.prompt (consumed by @nexus/social-and-engagement — peer referral
 * is the only non-paid discovery trigger in customer_evidence). Stamps
 * referral_prompted_at so the prompt fires exactly once per meeting.
 */
async function emitBookedEvents(params: {
  meeting: MeetingRow;
  prospect: ProspectForBooking;
  startIso: string;
  timezone: string;
  meetLink: string | null;
  nowMs: number;
}): Promise<void> {
  const { meeting, prospect, startIso, timezone, meetLink, nowMs } = params;
  const bus = buildEventBus();
  const base = {
    organizationId: meeting.organization_id,
    meetingId: meeting.id,
    prospectId: prospect.id,
    prospectEmail: prospect.email,
    prospectName: prospect.full_name || prospect.email,
    company: prospect.company_name || "",
    startsAt: startIso,
    timezone,
    meetLink,
    occurredAt: new Date(nowMs).toISOString(),
  };
  try {
    await bus.publish("sdr.meeting.booked", base);
  } catch (err) {
    log("warn", "emit_booked_failed", { error: String((err as Error).message) });
  }

  // Referral prompt — only once per meeting.
  const db = buildDb();
  const stamped = await db.query<{ id: string }>(
    `UPDATE sdr_meetings SET referral_prompted_at = NOW(), updated_at = NOW()
      WHERE organization_id = $1 AND id = $2 AND referral_prompted_at IS NULL
      RETURNING id`,
    meeting.organization_id,
    meeting.id,
  );
  if (stamped.length > 0) {
    try {
      await bus.publish("sdr.referral.prompt", {
        ...base,
        trigger: "first_booked_meeting",
      });
    } catch (err) {
      log("warn", "emit_referral_failed", { error: String((err as Error).message) });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — the cron entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface RunBookMeetingsOptions {
  nowMs: number;
  organizationId?: string;
  /** Max prospects to propose + meetings to book per org per run. */
  limit?: number;
}

export async function runBookMeetings(opts: RunBookMeetingsOptions): Promise<BookingSummary> {
  const { nowMs } = opts;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const db = buildDb();
  const summary: BookingSummary = {
    orgsProcessed: 0,
    proposed: 0,
    booked: 0,
    briefsDelivered: 0,
    skipped: 0,
    errors: 0,
  };

  // Resolve the set of orgs with booking work pending.
  let orgIds: string[];
  if (opts.organizationId) {
    orgIds = [opts.organizationId];
  } else {
    const rows = await db.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id FROM sdr_prospects WHERE status = 'booking_requested'
       UNION
       SELECT DISTINCT organization_id FROM sdr_meetings WHERE status IN ('proposed', 'confirmed')`,
    );
    orgIds = rows.map((r) => r.organization_id);
  }

  for (const organizationId of orgIds) {
    summary.orgsProcessed++;
    try {
      const mailbox = await loadMailbox(organizationId);

      // ── Propose pass ──────────────────────────────────────────────────────
      const pending = await db.query<ProspectForBooking & { reply_id: string | null }>(
        `SELECT ${PROSPECT_COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")},
                (SELECT r.id FROM sdr_replies r
                   WHERE r.organization_id = p.organization_id AND r.prospect_id = p.id
                     AND r.classification = 'interested'
                   ORDER BY r.received_at DESC LIMIT 1) AS reply_id
           FROM sdr_prospects p
          WHERE p.organization_id = $1 AND p.status = 'booking_requested'
            AND NOT EXISTS (
              SELECT 1 FROM sdr_meetings m
               WHERE m.organization_id = p.organization_id AND m.prospect_id = p.id
                 AND m.status IN ('proposed', 'confirmed'))
          ORDER BY p.updated_at ASC
          LIMIT $2`,
        organizationId,
        limit,
      );
      for (const row of pending) {
        try {
          const { reply_id, ...prospect } = row;
          const res = await proposeMeeting({
            prospect: prospect as ProspectForBooking,
            mailbox,
            replyId: reply_id,
            nowMs,
          });
          if (res.ok) summary.proposed++;
          else summary.skipped++;
        } catch (err) {
          summary.errors++;
          log("error", "propose_failed", { organizationId, prospectId: row.id, error: String((err as Error).message) });
        }
      }

      // ── Book pass ─────────────────────────────────────────────────────────
      const proposals = await db.query<MeetingRow>(
        `SELECT id, organization_id, prospect_id, campaign_id, mailbox_id, timezone,
                status, starts_at, created_at
           FROM sdr_meetings
          WHERE organization_id = $1 AND status = 'proposed' AND prospect_id IS NOT NULL
          ORDER BY created_at ASC LIMIT $2`,
        organizationId,
        limit,
      );
      for (const meeting of proposals) {
        try {
          if (!meeting.prospect_id) continue;
          const createdIso =
            meeting.created_at instanceof Date
              ? meeting.created_at.toISOString()
              : new Date(meeting.created_at).toISOString();
          const confirm = await latestConfirmingReply(organizationId, meeting.prospect_id, createdIso);
          if (!confirm) continue;
          const prospect = await loadProspect(organizationId, meeting.prospect_id);
          if (!prospect) continue;
          const res = await bookMeeting({
            meeting,
            prospect,
            mailbox,
            replyId: confirm.id,
            startIso:
              confirm.extracted_datetime instanceof Date
                ? (confirm.extracted_datetime as Date).toISOString()
                : new Date(confirm.extracted_datetime).toISOString(),
            nowMs,
          });
          if (res.ok) summary.booked++;
          else summary.skipped++;
        } catch (err) {
          summary.errors++;
          log("error", "book_failed", { organizationId, meetingId: meeting.id, error: String((err as Error).message) });
        }
      }

      // ── Brief delivery pass (12h before) ──────────────────────────────────
      const dueBriefs = await db.query<{ meeting_id: string }>(
        `SELECT b.meeting_id
           FROM sdr_meeting_briefs b
           JOIN sdr_meetings m ON m.id = b.meeting_id
          WHERE b.organization_id = $1 AND b.delivered_at IS NULL
            AND m.status = 'confirmed' AND m.starts_at IS NOT NULL
            AND m.starts_at > NOW()
            AND m.starts_at <= (NOW() + ($2::text || ' milliseconds')::interval)
          ORDER BY m.starts_at ASC LIMIT $3`,
        organizationId,
        String(BRIEF_LEAD_MS),
        limit,
      );
      for (const b of dueBriefs) {
        try {
          const delivered = await deliverBrief({ organizationId, meetingId: b.meeting_id, nowMs });
          if (delivered) summary.briefsDelivered++;
        } catch (err) {
          summary.errors++;
          log("error", "brief_deliver_failed", { organizationId, meetingId: b.meeting_id, error: String((err as Error).message) });
        }
      }
    } catch (err) {
      summary.errors++;
      log("error", "org_failed", { organizationId, error: String((err as Error).message) });
    }
  }

  log("info", "book_meetings_complete", { ...summary });
  return summary;
}
