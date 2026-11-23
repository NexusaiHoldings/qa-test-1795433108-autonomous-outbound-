/**
 * /meetings/[id] — the magazine-style pre-meeting brief (F1-008).
 *
 * A headline about the prospect, three signal callouts in cards, the full email
 * thread collapsed behind a disclosure, and a "what to say first" box. The brief
 * is composed when the meeting is booked (meeting-brief.ts) and surfaced here for
 * the founder to skim before the call.
 *
 * Server component: all data loaded server-side. No 'use client'.
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { buildDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FOUNDER_TZ = process.env.SDR_DEFAULT_TIMEZONE || "America/New_York";

const SIGNAL_LABELS: Record<string, string> = {
  funding: "Recent funding",
  hiring_surge: "Hiring surge",
  leadership_change: "Leadership change",
  product_launch: "Product launch",
  expansion: "Expansion",
  news: "In the news",
  tech_stack: "Tech stack",
};

interface MeetingRow {
  id: string;
  prospect_id: string | null;
  starts_at: string | Date | null;
  timezone: string | null;
  status: string;
  meet_link: string | null;
  full_name: string | null;
  company_name: string | null;
  title: string | null;
  email: string | null;
}

interface BriefRow {
  headline: string | null;
  brief_markdown: string | null;
  what_to_say_first: string | null;
  generated_at: string | Date | null;
  delivered_at: string | Date | null;
  source: string | null;
}

interface SignalRow {
  type: string;
  headline: string;
  source_url: string | null;
  observed_at: string | Date | null;
}

interface MessageRow {
  direction: string;
  subject: string | null;
  body_text: string | null;
  created_at: string | Date;
  sent_at: string | Date | null;
}

function signalLabel(type: string): string {
  return SIGNAL_LABELS[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatWhen(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

interface LoadedBrief {
  meeting: MeetingRow;
  brief: BriefRow | null;
  signals: SignalRow[];
  messages: MessageRow[];
}

async function loadBrief(organizationId: string, meetingId: string): Promise<LoadedBrief | null> {
  const db = buildDb();
  const meetingRows = await db.query<MeetingRow>(
    `SELECT m.id, m.prospect_id, m.starts_at, m.timezone, m.status, m.meet_link,
            p.full_name, p.company_name, p.title, p.email
       FROM sdr_meetings m
       LEFT JOIN sdr_prospects p ON p.id = m.prospect_id
      WHERE m.organization_id = $1 AND m.id = $2 LIMIT 1`,
    organizationId,
    meetingId,
  );
  const meeting = meetingRows[0];
  if (!meeting) return null;

  const [briefRows, signals, messages] = await Promise.all([
    db.query<BriefRow>(
      `SELECT headline, brief_markdown, what_to_say_first, generated_at, delivered_at, source
         FROM sdr_meeting_briefs
        WHERE organization_id = $1 AND meeting_id = $2 LIMIT 1`,
      organizationId,
      meetingId,
    ),
    meeting.prospect_id
      ? db.query<SignalRow>(
          `SELECT type, headline, source_url, observed_at
             FROM sdr_prospect_signals
            WHERE organization_id = $1 AND prospect_id = $2
            ORDER BY weight DESC, observed_at DESC
            LIMIT 3`,
          organizationId,
          meeting.prospect_id,
        )
      : Promise.resolve([] as SignalRow[]),
    meeting.prospect_id
      ? db.query<MessageRow>(
          `SELECT direction, subject, body_text, created_at, sent_at
             FROM sdr_messages
            WHERE organization_id = $1 AND prospect_id = $2
            ORDER BY COALESCE(sent_at, created_at) ASC
            LIMIT 40`,
          organizationId,
          meeting.prospect_id,
        )
      : Promise.resolve([] as MessageRow[]),
  ]);

  return { meeting, brief: briefRows[0] ?? null, signals, messages };
}

function SignalCard({ signal }: { signal: SignalRow }): JSX.Element {
  const observed = toIso(signal.observed_at);
  return (
    <div className="card" style={{ flex: "1 1 220px", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "#4f46e5" }}>
        {signalLabel(signal.type)}
      </div>
      <p style={{ margin: "6px 0 0", fontWeight: 500 }}>{signal.headline}</p>
      <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
        {signal.source_url ? (
          <a href={signal.source_url} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12 }}>
            Source
          </a>
        ) : null}
        {observed ? (
          <span className="muted" style={{ fontSize: 12 }}>
            {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
              new Date(observed),
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ThreadBubble({ message }: { message: MessageRow }): JSX.Element {
  const inbound = message.direction === "inbound";
  const when = toIso(message.sent_at) ?? toIso(message.created_at);
  return (
    <li
      style={{
        listStyle: "none",
        marginBottom: 10,
        display: "flex",
        justifyContent: inbound ? "flex-start" : "flex-end",
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          background: inbound ? "var(--substrate-surface-2, #f1f5f9)" : "#eef2ff",
          border: "1px solid var(--substrate-border, #e2e8f0)",
          borderRadius: 10,
          padding: "8px 12px",
        }}
      >
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          {inbound ? "Prospect" : "You"}
          {when
            ? ` · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(when))}`
            : ""}
        </div>
        {message.subject ? <div style={{ fontWeight: 600, fontSize: 13 }}>{message.subject}</div> : null}
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
          {(message.body_text || "").trim() || "(no text)"}
        </div>
      </div>
    </li>
  );
}

export default async function MeetingBriefPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Meeting brief</h1>
        <p>Please sign in to view this brief.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Meeting brief</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const data = await loadBrief(organizationId, params.id);
  if (!data) notFound();

  const { meeting, brief, signals, messages } = data;
  const tz = meeting.timezone || FOUNDER_TZ;
  const startIso = toIso(meeting.starts_at);
  const prospectName = meeting.full_name || meeting.email || "Your prospect";
  const headline =
    brief?.headline ||
    `${prospectName}${meeting.company_name ? ` at ${meeting.company_name}` : ""} — pre-meeting brief`;
  const whatToSayFirst =
    brief?.what_to_say_first ||
    `Open warm and curious: thank ${prospectName.split(" ")[0]} for making time, then ask what prompted them to reply. Listen before you pitch.`;

  return (
    <main>
      <p>
        <Link href="/meetings" className="muted">
          ← Back to meetings
        </Link>
      </p>

      {/* Magazine headline */}
      <h1 style={{ fontSize: 30, lineHeight: 1.15, marginBottom: 8 }}>{headline}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {meeting.title ? `${meeting.title} · ` : ""}
        {meeting.company_name || meeting.email}
        {startIso ? ` · ${formatWhen(startIso, tz)}` : " · time to be confirmed"}
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "8px 0 20px" }}>
        {meeting.meet_link ? (
          <a className="btn" href={meeting.meet_link} target="_blank" rel="noreferrer">
            Join video call
          </a>
        ) : null}
        <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>
          Status: {meeting.status}
          {brief?.delivered_at ? " · brief delivered" : brief ? " · brief ready" : " · brief pending"}
        </span>
      </div>

      {/* Three signal callouts */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16 }}>Three things to know</h2>
        {signals.length === 0 ? (
          <p className="muted">No specific signals captured — lead with discovery questions.</p>
        ) : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {signals.map((s, i) => (
              <SignalCard key={`${s.type}-${i}`} signal={s} />
            ))}
          </div>
        )}
      </section>

      {/* What to say first */}
      <section style={{ marginBottom: 24 }}>
        <div
          className="card"
          style={{ borderLeft: "4px solid #4f46e5", background: "var(--substrate-surface-2, #f8fafc)" }}
        >
          <h2 style={{ fontSize: 16, marginTop: 0 }}>What to say first</h2>
          <p style={{ marginBottom: 0, fontSize: 15 }}>{whatToSayFirst}</p>
        </div>
      </section>

      {/* Full thread, collapsed */}
      <section>
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            The conversation so far ({messages.length} message{messages.length === 1 ? "" : "s"})
          </summary>
          {messages.length === 0 ? (
            <p className="muted" style={{ marginTop: 12 }}>
              No messages on record.
            </p>
          ) : (
            <ul style={{ padding: 0, margin: "12px 0 0" }}>
              {messages.map((m, i) => (
                <ThreadBubble key={i} message={m} />
              ))}
            </ul>
          )}
        </details>
      </section>
    </main>
  );
}
