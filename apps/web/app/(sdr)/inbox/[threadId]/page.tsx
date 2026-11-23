/**
 * /inbox/[threadId] — the thread view (F1-007). threadId == prospect id.
 *
 * Renders the conversation as chat bubbles: outbound touches in a muted surface,
 * inbound replies in white with depth, each inbound tagged with its classification
 * pill + confidence + the agent's reasoning. The agent's planned next touch (a
 * queued outbound message with a future next_send_at) appears as a dashed
 * "scheduled" bubble the founder can edit inline or cancel. Open customer-scope
 * escalations surface a "needs you" banner the founder resolves in place.
 *
 * Server component: data loaded server-side; mutations run via server actions.
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { buildDb } from "@/lib/db";
import { REPLY_CLASSIFICATIONS, type ReplyClassification } from "@/lib/sdr/reply-classifier";
import { editScheduledTouchAction, cancelScheduledTouchAction, resolveReviewAction } from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LANE_COLORS: Record<ReplyClassification, string> = {
  interested: "#15803d",
  soft_objection: "#b45309",
  out_of_office: "#0369a1",
  wrong_person: "#6d28d9",
  hard_no: "#be123c",
  unsubscribe: "#334155",
  legal_threat: "#991b1b",
  unclear: "#64748b",
};

const LANE_LABELS: Record<ReplyClassification, string> = {
  interested: "Interested",
  soft_objection: "Soft objection",
  out_of_office: "Out of office",
  wrong_person: "Wrong person",
  hard_no: "Hard no",
  unsubscribe: "Unsubscribe",
  legal_threat: "Legal threat",
  unclear: "Unclear",
};

interface ProspectRow {
  id: string;
  full_name: string | null;
  company_name: string | null;
  email: string | null;
  title: string | null;
  status: string;
}

interface MessageRow {
  id: string;
  direction: string;
  subject: string | null;
  body_text: string | null;
  status: string;
  sent_at: string | Date | null;
  next_send_at: string | Date | null;
  created_at: string | Date;
  touch_index: number;
}

interface ReplyRow {
  message_id: string | null;
  classification: string;
  confidence: number | string;
  reasoning: string | null;
  extracted_datetime: string | Date | null;
  handled_by: string;
  action_taken: string | null;
}

interface ReviewRow {
  id: string;
  scope: string;
  reason: string;
  status: string;
  created_at: string | Date;
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function coerceClassification(value: string): ReplyClassification {
  return (REPLY_CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as ReplyClassification)
    : "unclear";
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderBody(body: string): JSX.Element {
  const lines = (body ?? "").replace(/\r/g, "").split("\n");
  return (
    <div style={{ lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {lines.map((line, i) => (line.trim() ? <p key={i} style={{ margin: "0 0 6px" }}>{line}</p> : <div key={i} style={{ height: 8 }} aria-hidden="true" />))}
    </div>
  );
}

function OutboundBubble({ msg }: { msg: MessageRow }): JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
      <div
        className="card"
        style={{
          maxWidth: "72%",
          background: "var(--substrate-surface-2, #f1f5f9)",
          borderColor: "transparent",
        }}
      >
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          You · touch {msg.touch_index + 1} · {msg.status === "sent" ? `sent ${formatWhen(toIso(msg.sent_at))}` : msg.status}
        </div>
        {msg.subject ? <div style={{ fontWeight: 600, marginBottom: 4 }}>{msg.subject}</div> : null}
        {renderBody(msg.body_text ?? "")}
      </div>
    </div>
  );
}

function InboundBubble({ msg, reply }: { msg: MessageRow; reply?: ReplyRow }): JSX.Element {
  const cls = reply ? coerceClassification(reply.classification) : null;
  const confidence = reply ? Number(reply.confidence) || 0 : 0;
  return (
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 14 }}>
      <div
        style={{
          maxWidth: "72%",
          background: "#ffffff",
          border: "1px solid var(--substrate-border, #e2e8f0)",
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: "0 2px 10px rgba(15, 23, 42, 0.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 11 }}>Reply · {formatWhen(toIso(msg.sent_at) ?? toIso(msg.created_at))}</span>
          {cls ? (
            <span style={{ display: "inline-block", padding: "1px 9px", borderRadius: 999, fontSize: 11, fontWeight: 600, color: "#fff", background: LANE_COLORS[cls] }}>
              {LANE_LABELS[cls]}
            </span>
          ) : null}
          {reply ? (
            <span className="muted" style={{ fontSize: 11 }}>
              {(confidence * 100).toFixed(0)}% confident
            </span>
          ) : null}
        </div>
        {msg.subject ? <div style={{ fontWeight: 600, marginBottom: 4 }}>{msg.subject}</div> : null}
        {renderBody(msg.body_text ?? "")}
        {reply?.reasoning ? (
          <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0, fontStyle: "italic" }}>
            Agent read: {reply.reasoning}
          </p>
        ) : null}
        {reply?.action_taken ? (
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Action: {reply.action_taken.replace(/_/g, " ")}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Dashed "scheduled" bubble — the agent's planned next touch, editable or cancelable. */
function ScheduledBubble({ msg }: { msg: MessageRow }): JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
      <div
        style={{
          maxWidth: "72%",
          width: "100%",
          border: "2px dashed var(--substrate-accent, #4f46e5)",
          borderRadius: 12,
          padding: "12px 14px",
          background: "transparent",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--substrate-accent, #4f46e5)", marginBottom: 6 }}>
          Scheduled · sends {formatWhen(toIso(msg.next_send_at))}
        </div>
        <form action={editScheduledTouchAction}>
          <input type="hidden" name="messageId" value={msg.id} />
          <label htmlFor={`subject_${msg.id}`}>Subject</label>
          <input id={`subject_${msg.id}`} name="subject" defaultValue={msg.subject ?? ""} />
          <label htmlFor={`body_${msg.id}`}>Message</label>
          <textarea id={`body_${msg.id}`} name="body" rows={6} defaultValue={msg.body_text ?? ""} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button type="submit">Save changes</button>
            <button type="submit" formAction={cancelScheduledTouchAction} className="btn secondary">
              Cancel this touch
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: { threadId: string };
  searchParams?: { status?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Thread</h1>
        <p>Please sign in to view this conversation.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Thread</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const prospectId = params.threadId;
  const db = buildDb();

  const prospectRows = await db.query<ProspectRow>(
    `SELECT id, full_name, company_name, email, title, status
       FROM sdr_prospects
      WHERE organization_id = $1 AND id = $2
      LIMIT 1`,
    organizationId,
    prospectId,
  );
  const prospect = prospectRows[0];
  if (!prospect) {
    notFound();
  }

  const [messages, replies, reviews] = await Promise.all([
    db.query<MessageRow>(
      `SELECT id, direction, subject, body_text, status, sent_at, next_send_at, created_at, touch_index
         FROM sdr_messages
        WHERE organization_id = $1 AND prospect_id = $2
        ORDER BY COALESCE(sent_at, next_send_at, created_at) ASC, touch_index ASC`,
      organizationId,
      prospectId,
    ),
    db.query<ReplyRow>(
      `SELECT message_id, classification, confidence, reasoning, extracted_datetime, handled_by, action_taken
         FROM sdr_replies
        WHERE organization_id = $1 AND prospect_id = $2`,
      organizationId,
      prospectId,
    ),
    db.query<ReviewRow>(
      `SELECT id, scope, reason, status, created_at
         FROM sdr_review_queue
        WHERE organization_id = $1 AND prospect_id = $2 AND status = 'open'
        ORDER BY created_at DESC`,
      organizationId,
      prospectId,
    ),
  ]);

  const replyByMessage = new Map<string, ReplyRow>();
  for (const r of replies) if (r.message_id) replyByMessage.set(r.message_id, r);

  const customerReview = reviews.find((r) => r.scope === "customer");
  const statusMsg = (searchParams?.status ?? "").trim();
  const prospectName = prospect.full_name || prospect.email || "Unknown prospect";

  return (
    <main>
      <p style={{ margin: "0 0 8px" }}>
        <Link href="/inbox">← Back to inbox</Link>
      </p>
      <h1 style={{ marginBottom: 2 }}>{prospectName}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {prospect.title ? `${prospect.title} · ` : ""}
        {prospect.company_name ?? ""} {prospect.email ? `· ${prospect.email}` : ""} · status <code>{prospect.status}</code>
      </p>

      {statusMsg ? (
        <p className="card" role="status">
          {statusMsg === "edited"
            ? "Scheduled touch updated."
            : statusMsg === "cancelled"
              ? "Scheduled touch cancelled."
              : statusMsg === "resolved"
                ? "Review resolved."
                : statusMsg}
        </p>
      ) : null}

      {customerReview ? (
        <div className="card" role="alert" style={{ borderColor: "#be123c" }}>
          <strong style={{ color: "#be123c" }}>Needs you.</strong>{" "}
          Your agent wasn&apos;t confident enough to act on the latest reply
          {customerReview.reason ? ` (${customerReview.reason.replace(/_/g, " ")})` : ""}.
          Review the thread below and resolve it once you&apos;ve followed up.
          <form action={resolveReviewAction} style={{ marginTop: 10 }}>
            <input type="hidden" name="reviewId" value={customerReview.id} />
            <input type="hidden" name="prospectId" value={prospectId} />
            <label htmlFor="resolution_note">Note (optional)</label>
            <input id="resolution_note" name="note" placeholder="e.g. replied manually, booked for Tuesday" />
            <button type="submit" style={{ marginTop: 8 }}>Mark resolved</button>
          </form>
        </div>
      ) : null}

      <section style={{ marginTop: 20, maxWidth: 820 }}>
        {messages.length === 0 ? (
          <div className="empty"><p>No messages in this conversation yet.</p></div>
        ) : (
          messages.map((msg) => {
            if (msg.direction === "inbound") {
              return <InboundBubble key={msg.id} msg={msg} reply={replyByMessage.get(msg.id)} />;
            }
            const isScheduled = msg.status === "queued" && !!msg.next_send_at;
            return isScheduled ? (
              <ScheduledBubble key={msg.id} msg={msg} />
            ) : (
              <OutboundBubble key={msg.id} msg={msg} />
            );
          })
        )}
      </section>
    </main>
  );
}
