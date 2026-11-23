/**
 * /meetings — the booked-meetings surface (F1-008).
 *
 * A calendar-week STRIP at the top renders the next seven days with each booked
 * slot as an accent-colored block, over a LIST of meeting cards (prospect avatar,
 * company, time in the FOUNDER'S timezone, and a "brief ready" badge). Clicking a
 * card opens the magazine-style brief at /meetings/[id]. The empty state shows an
 * open-calendar illustration and the encouraging "Your first booked meeting
 * usually lands in week one."
 *
 * Server component: all data is loaded server-side. No 'use client'.
 */

import type { JSX } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { buildDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FOUNDER_TZ = process.env.SDR_DEFAULT_TIMEZONE || "America/New_York";
const ACCENT = "#4f46e5";

const STATUS_META: Record<string, { label: string; color: string }> = {
  proposed: { label: "Awaiting pick", color: "#b45309" },
  confirmed: { label: "Confirmed", color: "#15803d" },
  held: { label: "Held", color: "#0369a1" },
  no_show: { label: "No-show", color: "#be123c" },
  cancelled: { label: "Cancelled", color: "#64748b" },
};

interface MeetingRow {
  id: string;
  starts_at: string | Date | null;
  timezone: string | null;
  status: string;
  meet_link: string | null;
  full_name: string | null;
  company_name: string | null;
  email: string | null;
  brief_ready: boolean;
}

interface MeetingView {
  id: string;
  startIso: string | null;
  status: string;
  meetLink: string | null;
  prospectName: string;
  company: string;
  email: string;
  briefReady: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function tzDateKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FOUNDER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: FOUNDER_TZ,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: FOUNDER_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

async function loadMeetings(organizationId: string): Promise<MeetingView[]> {
  const db = buildDb();
  const rows = await db.query<MeetingRow>(
    `SELECT m.id, m.starts_at, m.timezone, m.status, m.meet_link,
            p.full_name, p.company_name, p.email,
            (b.id IS NOT NULL) AS brief_ready
       FROM sdr_meetings m
       LEFT JOIN sdr_prospects p ON p.id = m.prospect_id
       LEFT JOIN sdr_meeting_briefs b ON b.meeting_id = m.id
      WHERE m.organization_id = $1 AND m.status <> 'cancelled'
      ORDER BY COALESCE(m.starts_at, m.created_at) ASC`,
    organizationId,
  );
  return rows.map((r) => ({
    id: r.id,
    startIso:
      r.starts_at instanceof Date ? r.starts_at.toISOString() : r.starts_at ? String(r.starts_at) : null,
    status: r.status,
    meetLink: r.meet_link,
    prospectName: r.full_name || r.email || "Unknown prospect",
    company: r.company_name ?? "",
    email: r.email ?? "",
    briefReady: Boolean(r.brief_ready),
  }));
}

/** Next-7-days strip with booked slots as accent blocks. */
function WeekStrip({ meetings }: { meetings: MeetingView[] }): JSX.Element {
  // Build 7 day columns starting today (founder tz), keyed by local date.
  const today = new Date();
  const days: { key: string; label: string; iso: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const iso = new Date(today.getTime() + i * 24 * 60 * 60_000).toISOString();
    days.push({ key: tzDateKey(iso), label: formatDay(iso), iso });
  }
  const byDay = new Map<string, MeetingView[]>();
  for (const m of meetings) {
    if (!m.startIso || m.status === "proposed") continue;
    const key = tzDateKey(m.startIso);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(m);
  }

  return (
    <section aria-label="This week" style={{ marginBottom: 24 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 8,
          alignItems: "stretch",
        }}
      >
        {days.map((d) => {
          const items = (byDay.get(d.key) ?? []).sort((a, b) =>
            (a.startIso ?? "").localeCompare(b.startIso ?? ""),
          );
          return (
            <div
              key={d.key}
              className="card"
              style={{ padding: 8, minHeight: 96, display: "flex", flexDirection: "column", gap: 6 }}
            >
              <div className="muted" style={{ fontSize: 11, fontWeight: 600 }}>
                {d.label}
              </div>
              {items.length === 0 ? (
                <div className="muted" style={{ fontSize: 11, opacity: 0.6 }}>
                  —
                </div>
              ) : (
                items.map((m) => (
                  <Link
                    key={m.id}
                    href={`/meetings/${encodeURIComponent(m.id)}`}
                    style={{
                      display: "block",
                      background: ACCENT,
                      color: "#fff",
                      borderRadius: 6,
                      padding: "4px 6px",
                      fontSize: 11,
                      textDecoration: "none",
                      lineHeight: 1.3,
                    }}
                    title={`${m.prospectName} — ${m.startIso ? formatTime(m.startIso) : ""}`}
                  >
                    <strong style={{ display: "block" }}>{m.startIso ? formatTime(m.startIso) : ""}</strong>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                      {m.company || m.prospectName}
                    </span>
                  </Link>
                ))
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BriefBadge(): JSX.Element {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color: "#fff",
        background: "#15803d",
      }}
    >
      Brief ready
    </span>
  );
}

function MeetingCard({ meeting }: { meeting: MeetingView }): JSX.Element {
  const status = STATUS_META[meeting.status] ?? { label: meeting.status, color: "#64748b" };
  return (
    <li style={{ listStyle: "none", marginBottom: 10 }}>
      <Link
        href={`/meetings/${encodeURIComponent(meeting.id)}`}
        className="card"
        style={{ display: "flex", gap: 12, alignItems: "center", textDecoration: "none", color: "inherit" }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "var(--substrate-surface-2, #e2e8f0)",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {initials(meeting.prospectName)}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{meeting.prospectName}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {meeting.company || meeting.email}
          </div>
          <div style={{ fontSize: 13, marginTop: 2 }}>
            {meeting.startIso ? `${formatDay(meeting.startIso)} · ${formatTime(meeting.startIso)}` : "Time to be confirmed"}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: status.color }}>{status.label}</span>
          {meeting.briefReady ? <BriefBadge /> : null}
        </div>
      </Link>
    </li>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="empty" style={{ padding: "48px 24px" }}>
      <svg width="140" height="96" viewBox="0 0 140 96" aria-hidden="true" style={{ marginBottom: 12 }}>
        <rect x="18" y="18" width="104" height="70" rx="10" fill="#fff" stroke={ACCENT} strokeWidth="3" />
        <line x1="18" y1="36" x2="122" y2="36" stroke={ACCENT} strokeWidth="3" />
        <line x1="40" y1="12" x2="40" y2="26" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
        <line x1="100" y1="12" x2="100" y2="26" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
        <circle cx="52" cy="54" r="5" fill="#94a3b8" />
        <circle cx="70" cy="54" r="5" fill="#94a3b8" />
        <circle cx="88" cy="54" r="5" fill="#94a3b8" />
        <circle cx="52" cy="72" r="5" fill="#94a3b8" />
        <circle cx="70" cy="72" r="5" fill={ACCENT} />
      </svg>
      <h2 style={{ marginTop: 0 }}>No meetings booked yet</h2>
      <p className="muted">Your first booked meeting usually lands in week one.</p>
    </div>
  );
}

export default async function MeetingsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Meetings</h1>
        <p>Please sign in to view your booked meetings.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Meetings</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const meetings = await loadMeetings(organizationId);
  const booked = meetings.filter((m) => m.status !== "proposed");
  const pending = meetings.filter((m) => m.status === "proposed");

  if (meetings.length === 0) {
    return (
      <main>
        <h1>Meetings</h1>
        <p>When a prospect picks a time, your agent books it into your calendar and writes you a brief.</p>
        <EmptyState />
      </main>
    );
  }

  return (
    <main>
      <h1>Meetings</h1>
      <p>Your agent books confirmed meetings into your calendar and prepares a brief for each one.</p>

      <WeekStrip meetings={meetings} />

      <section>
        <h2 style={{ fontSize: 16 }}>Booked ({booked.length})</h2>
        {booked.length === 0 ? (
          <div className="empty">
            <p>No confirmed meetings yet — a few proposals are out and awaiting a reply.</p>
          </div>
        ) : (
          <ul style={{ padding: 0, margin: 0 }}>
            {booked.map((m) => (
              <MeetingCard key={m.id} meeting={m} />
            ))}
          </ul>
        )}
      </section>

      {pending.length > 0 ? (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16 }}>Awaiting a pick ({pending.length})</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Slots offered — waiting for the prospect to choose a time.
          </p>
          <ul style={{ padding: 0, margin: 0 }}>
            {pending.map((m) => (
              <MeetingCard key={m.id} meeting={m} />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
