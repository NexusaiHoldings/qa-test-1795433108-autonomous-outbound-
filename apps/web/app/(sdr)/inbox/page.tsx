/**
 * /inbox — the conversation engine surface (F1-007).
 *
 * Three-pane conversation UI: classification LANES on the left, a THREAD LIST on
 * the right with a classification pill + confidence dot per thread, and a dedicated
 * "needs you" lane surfacing customer-scope escalations (low-confidence / unclear
 * replies the agent flagged for the founder). Clicking a thread opens the thread
 * view at /inbox/[threadId] (threadId == prospect id), where messages render as
 * chat bubbles and the agent's planned next touch appears as an editable dashed
 * "scheduled" bubble.
 *
 * Server component: all data is loaded server-side; the lane filter round-trips
 * through the `?lane=` query string. No 'use client'.
 */

import type { JSX } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { buildDb } from "@/lib/db";
import { REPLY_CLASSIFICATIONS, type ReplyClassification } from "@/lib/sdr/reply-classifier";
import { checkNowAction } from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface LaneMeta {
  label: string;
  color: string;
  blurb: string;
}

const LANE_META: Record<ReplyClassification, LaneMeta> = {
  interested: { label: "Interested", color: "#15803d", blurb: "Ready to book — handed to scheduling." },
  soft_objection: { label: "Soft objection", color: "#b45309", blurb: "Agent sent one grounded follow-up." },
  out_of_office: { label: "Out of office", color: "#0369a1", blurb: "Next touch rescheduled automatically." },
  wrong_person: { label: "Wrong person", color: "#6d28d9", blurb: "Sequence closed." },
  hard_no: { label: "Hard no", color: "#be123c", blurb: "Sequence closed." },
  unsubscribe: { label: "Unsubscribe", color: "#334155", blurb: "Suppressed — no reply sent." },
  legal_threat: { label: "Legal threat", color: "#991b1b", blurb: "Suppressed + escalated to an operator." },
  unclear: { label: "Unclear", color: "#64748b", blurb: "Flagged for your review." },
};

interface ThreadRow {
  prospect_id: string;
  reply_id: string;
  classification: string;
  confidence: number | string;
  received_at: string | Date;
  handled_by: string;
  subject: string | null;
  body_text: string | null;
  full_name: string | null;
  company_name: string | null;
  email: string | null;
}

interface ThreadView {
  prospectId: string;
  classification: ReplyClassification;
  confidence: number;
  receivedAt: string;
  handledBy: string;
  prospectName: string;
  company: string;
  email: string;
  snippet: string;
  needsYou: boolean;
}

function coerceClassification(value: string): ReplyClassification {
  return (REPLY_CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as ReplyClassification)
    : "unclear";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Confidence dot — filled proportional to certainty; red ring when below threshold. */
function ConfidenceDot({ confidence }: { confidence: number }): JSX.Element {
  const low = confidence < 0.85;
  const color = low ? "#be123c" : "#15803d";
  return (
    <span
      title={`Confidence ${(confidence * 100).toFixed(0)}%`}
      aria-label={`Confidence ${(confidence * 100).toFixed(0)} percent`}
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        opacity: Math.max(0.35, Math.min(1, confidence)),
        boxShadow: low ? `0 0 0 2px #fde2e4` : undefined,
        flexShrink: 0,
      }}
    />
  );
}

function ClassificationPill({ classification }: { classification: ReplyClassification }): JSX.Element {
  const meta = LANE_META[classification];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: meta.color,
      }}
    >
      {meta.label}
    </span>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="empty" style={{ padding: "48px 24px" }}>
      <svg width="120" height="80" viewBox="0 0 120 80" aria-hidden="true" style={{ marginBottom: 12 }}>
        <rect x="8" y="14" width="64" height="40" rx="10" fill="none" stroke="#94a3b8" strokeWidth="3" />
        <path d="M24 54 l0 12 l14 -12" fill="none" stroke="#94a3b8" strokeWidth="3" strokeLinejoin="round" />
        <rect x="52" y="30" width="60" height="38" rx="10" fill="#fff" stroke="#4f46e5" strokeWidth="3" />
        <path d="M96 68 l0 10 l-12 -10" fill="#fff" stroke="#4f46e5" strokeWidth="3" strokeLinejoin="round" />
      </svg>
      <h2 style={{ marginTop: 0 }}>Replies show up here</h2>
      <p className="muted">Your agent handles the easy ones and flags the rest.</p>
    </div>
  );
}

function ThreadCard({ thread }: { thread: ThreadView }): JSX.Element {
  return (
    <li style={{ listStyle: "none", marginBottom: 8 }}>
      <Link
        href={`/inbox/${encodeURIComponent(thread.prospectId)}`}
        className="card"
        style={{
          display: "block",
          textDecoration: "none",
          color: "inherit",
          borderColor: thread.needsYou ? "#be123c" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "var(--substrate-surface-2, #e2e8f0)",
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {initials(thread.prospectName)}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {thread.prospectName}
              </span>
              <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>{formatWhen(thread.receivedAt)}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {thread.company || thread.email}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <ClassificationPill classification={thread.classification} />
          <ConfidenceDot confidence={thread.confidence} />
          {thread.needsYou ? (
            <span style={{ color: "#be123c", fontSize: 12, fontWeight: 600 }}>Needs you</span>
          ) : null}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{thread.snippet}</div>
      </Link>
    </li>
  );
}

async function loadThreads(organizationId: string): Promise<ThreadView[]> {
  const db = buildDb();
  const [rows, reviews] = await Promise.all([
    db.query<ThreadRow>(
      `SELECT DISTINCT ON (r.prospect_id)
              r.prospect_id, r.id AS reply_id, r.classification, r.confidence,
              r.received_at, r.handled_by, r.subject, r.body_text,
              p.full_name, p.company_name, p.email
         FROM sdr_replies r
         LEFT JOIN sdr_prospects p ON p.id = r.prospect_id
        WHERE r.organization_id = $1 AND r.prospect_id IS NOT NULL
        ORDER BY r.prospect_id, r.received_at DESC`,
      organizationId,
    ),
    db.query<{ prospect_id: string; open_count: string }>(
      `SELECT prospect_id, COUNT(*)::text AS open_count
         FROM sdr_review_queue
        WHERE organization_id = $1 AND status = 'open' AND scope = 'customer'
          AND prospect_id IS NOT NULL
        GROUP BY prospect_id`,
      organizationId,
    ),
  ]);

  const needsYou = new Set(reviews.filter((r) => Number(r.open_count) > 0).map((r) => r.prospect_id));

  return rows.map((row) => {
    const receivedAt =
      row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at);
    const body = (row.body_text ?? "").replace(/\s+/g, " ").trim();
    return {
      prospectId: row.prospect_id,
      classification: coerceClassification(row.classification),
      confidence: Number(row.confidence) || 0,
      receivedAt,
      handledBy: row.handled_by,
      prospectName: row.full_name || row.email || "Unknown",
      company: row.company_name ?? "",
      email: row.email ?? "",
      snippet: body.length > 120 ? `${body.slice(0, 120)}…` : body,
      needsYou: needsYou.has(row.prospect_id),
    };
  });
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams?: { lane?: string; status?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Inbox</h1>
        <p>Please sign in to view your conversations.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Inbox</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const threads = await loadThreads(organizationId);
  const activeLane = (searchParams?.lane ?? "").trim();
  const statusMsg = (searchParams?.status ?? "").trim();

  // Lane counts.
  const needsYouCount = threads.filter((t) => t.needsYou).length;
  const laneCounts = new Map<string, number>();
  for (const t of threads) laneCounts.set(t.classification, (laneCounts.get(t.classification) ?? 0) + 1);

  const filtered =
    activeLane === "needs_you"
      ? threads.filter((t) => t.needsYou)
      : activeLane && (REPLY_CLASSIFICATIONS as readonly string[]).includes(activeLane)
        ? threads.filter((t) => t.classification === activeLane)
        : threads;

  if (threads.length === 0) {
    return (
      <main>
        <h1>Inbox</h1>
        <p>Your agent handles replies as they land. The easy ones are resolved automatically; anything it is unsure of is flagged for you.</p>
        <form action={checkNowAction}>
          <button type="submit" className="btn secondary">Check for new replies</button>
        </form>
        <EmptyState />
      </main>
    );
  }

  return (
    <main>
      <h1>Inbox</h1>
      <p>Your agent handles the easy replies and flags the rest. Pick a lane, then open a thread to see the conversation.</p>

      {statusMsg ? <p className="card" role="status">{statusMsg === "checked" ? "Checked for new replies." : statusMsg}</p> : null}

      <form action={checkNowAction} style={{ marginBottom: 12 }}>
        <button type="submit" className="btn secondary">Check for new replies</button>
      </form>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 1fr) minmax(0, 3fr)", gap: 20, alignItems: "start" }}>
        {/* Left pane: classification lanes */}
        <section>
          <h2 style={{ fontSize: 15 }}>Lanes</h2>
          <ul style={{ padding: 0, margin: 0 }}>
            <li style={{ listStyle: "none", marginBottom: 6 }}>
              <Link
                href="/inbox"
                className="card"
                style={{ display: "flex", justifyContent: "space-between", textDecoration: "none", color: "inherit", borderColor: !activeLane ? "#4f46e5" : undefined }}
              >
                <span>All</span>
                <span className="muted">{threads.length}</span>
              </Link>
            </li>
            <li style={{ listStyle: "none", marginBottom: 6 }}>
              <Link
                href="/inbox?lane=needs_you"
                className="card"
                style={{ display: "flex", justifyContent: "space-between", textDecoration: "none", color: "inherit", borderColor: activeLane === "needs_you" ? "#be123c" : undefined }}
              >
                <span style={{ fontWeight: 600, color: "#be123c" }}>Needs you</span>
                <span className="muted">{needsYouCount}</span>
              </Link>
            </li>
            {REPLY_CLASSIFICATIONS.map((cls) => {
              const count = laneCounts.get(cls) ?? 0;
              if (count === 0) return null;
              return (
                <li key={cls} style={{ listStyle: "none", marginBottom: 6 }}>
                  <Link
                    href={`/inbox?lane=${encodeURIComponent(cls)}`}
                    className="card"
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", textDecoration: "none", color: "inherit", borderColor: activeLane === cls ? LANE_META[cls].color : undefined }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: LANE_META[cls].color, display: "inline-block" }} aria-hidden="true" />
                      {LANE_META[cls].label}
                    </span>
                    <span className="muted">{count}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Right pane: thread list */}
        <section>
          <h2 style={{ fontSize: 15 }}>
            {activeLane === "needs_you"
              ? `Needs you (${filtered.length})`
              : activeLane && (REPLY_CLASSIFICATIONS as readonly string[]).includes(activeLane)
                ? `${LANE_META[activeLane as ReplyClassification].label} (${filtered.length})`
                : `All conversations (${filtered.length})`}
          </h2>
          {filtered.length === 0 ? (
            <div className="empty"><p>No threads in this lane.</p></div>
          ) : (
            <ul style={{ padding: 0, margin: 0 }}>
              {filtered.map((t) => (
                <ThreadCard key={t.prospectId} thread={t} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
