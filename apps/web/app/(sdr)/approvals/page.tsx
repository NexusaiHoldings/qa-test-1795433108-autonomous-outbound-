/**
 * First-send approval queue (F1-005) — liability_assessor.human_in_loop_required_for[0].
 *
 * Inbox-style: pending sequences on the left, a full-bleed email preview on the
 * right rendered as a real email (sender avatar, subject line, body). Each
 * personalized sentence is underlined with a hover popover showing the signal it
 * cites. The founder edits inline and approves — approving unlocks the segment so
 * subsequent sequences in it send autonomously ("I didn't write a single message").
 *
 * Server component: selection is driven by the `?seq=` query param (no client JS).
 * Approve is blocked until @nexus/legal-and-compliance reports the AUP acknowledged.
 */

import type { JSX } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import {
  listPendingSequences,
  getApprovalDetail,
  segmentProgress,
  isAupAcknowledged,
  type PendingSequenceRow,
  type ApprovalDetail,
  type ApprovalMessage,
} from "@/lib/sdr/sequence-generator";
import { approveSequenceAction, approveSegmentAction, skipSequenceAction } from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACCENT = "var(--substrate-accent, #4f46e5)";

const STATUS_MESSAGES: Record<string, string> = {
  approved: "Sequence approved and queued.",
  segment_unlocked: "Segment unlocked — new sequences here now send autonomously.",
  skipped: "Sequence skipped. It will not be sent.",
  aup_required: "Acknowledge the Acceptable Use Policy before approving a first send.",
  approve_failed: "Could not approve that sequence. It may have already been handled.",
  unauthorized: "Please sign in to review approvals.",
  no_org: "No active organization selected.",
  missing_sequence: "Select a sequence to act on.",
  missing_segment: "Could not resolve that segment.",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 %$]/g, "").replace(/\s+/g, " ").trim();
}

const TOUCH_LABELS = ["Intro", "Value follow-up", "Break-up"];

/** Render a message body with cited (personalized) sentences underlined + popover. */
function renderBody(
  body: string,
  citations: Array<{ sentence: string; headline: string }>,
): JSX.Element {
  const cites = citations
    .map((c) => ({ norm: normalizeForMatch(c.sentence), headline: c.headline }))
    .filter((c) => c.norm.length > 0);
  const lines = body.replace(/\r/g, "").split("\n");

  return (
    <div style={{ lineHeight: 1.6 }}>
      {lines.map((line, li) => {
        if (!line.trim()) {
          return <div key={li} style={{ height: 10 }} aria-hidden="true" />;
        }
        const sentences = line.split(/(?<=[.!?])\s+/);
        return (
          <p key={li} style={{ margin: "0 0 8px" }}>
            {sentences.map((s, si) => {
              const n = normalizeForMatch(s);
              const hit =
                n.length > 0
                  ? cites.find((c) => n.includes(c.norm) || c.norm.includes(n))
                  : undefined;
              if (hit) {
                return (
                  <span
                    key={si}
                    title={`Cited signal: ${hit.headline}`}
                    style={{
                      textDecoration: "underline",
                      textDecorationStyle: "dotted",
                      textDecorationColor: ACCENT,
                      textUnderlineOffset: 3,
                      cursor: "help",
                    }}
                  >
                    {s}{" "}
                  </span>
                );
              }
              return <span key={si}>{s}{" "}</span>;
            })}
          </p>
        );
      })}
    </div>
  );
}

/** SVG progress ring — "Approve N to unlock autonomous sending". */
function ProgressRing({ approved, threshold }: { approved: number; threshold: number }): JSX.Element {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, threshold > 0 ? approved / threshold : 1));
  const offset = circumference * (1 - pct);
  const remaining = Math.max(0, threshold - approved);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={`${approved} of ${threshold} approved`}>
        <circle cx="32" cy="32" r={radius} fill="none" stroke="var(--substrate-border, #e2e8f0)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke={ACCENT}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 32 32)"
        />
        <text x="32" y="37" textAnchor="middle" fontSize="16" fontWeight="700" fill="currentColor">
          {approved}/{threshold}
        </text>
      </svg>
      <span className="muted" style={{ fontSize: 13 }}>
        {remaining > 0
          ? `Approve ${remaining} more to unlock autonomous sending.`
          : "Autonomous sending unlocked for this segment."}
      </span>
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="empty" style={{ padding: "48px 24px" }}>
      <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true" style={{ marginBottom: 12 }}>
        <circle cx="48" cy="48" r="44" fill="none" stroke={ACCENT} strokeWidth="4" />
        <path
          d="M30 49 l12 12 l24 -26"
          fill="none"
          stroke={ACCENT}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <h2 style={{ marginTop: 0 }}>Your SDR is live — go bill some hours.</h2>
      <p className="muted">
        Nothing is waiting on you. New segments will appear here for a quick first-batch review.
      </p>
    </div>
  );
}

function SequenceListItem({
  item,
  selected,
}: {
  item: PendingSequenceRow;
  selected: boolean;
}): JSX.Element {
  return (
    <li style={{ listStyle: "none", marginBottom: 8 }}>
      <Link
        href={`/approvals?seq=${encodeURIComponent(item.id)}`}
        className="card"
        style={{
          display: "block",
          textDecoration: "none",
          color: "inherit",
          borderColor: selected ? ACCENT : undefined,
          borderWidth: selected ? 2 : undefined,
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
            {initials(item.prospectName)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.prospectName}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {item.company} · <code>{item.segmentKey}</code>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600 }}>{item.subject}</div>
        <div className="muted" style={{ fontSize: 12 }}>{item.snippet}…</div>
      </Link>
    </li>
  );
}

function MessageEditor({ message }: { message: ApprovalMessage }): JSX.Element {
  const label = TOUCH_LABELS[message.touchIndex] ?? `Touch ${message.touchIndex + 1}`;
  return (
    <fieldset className="card" style={{ marginBottom: 12 }}>
      <legend style={{ fontWeight: 600 }}>
        Touch {message.touchIndex + 1} · {label}
      </legend>
      <input type="hidden" name={`msgid_${message.touchIndex}`} value={message.id} />
      <label htmlFor={`subject_${message.touchIndex}`}>Subject</label>
      <input id={`subject_${message.touchIndex}`} name={`subject_${message.touchIndex}`} defaultValue={message.subject} />
      <label htmlFor={`body_${message.touchIndex}`}>Body</label>
      <textarea id={`body_${message.touchIndex}`} name={`body_${message.touchIndex}`} rows={8} defaultValue={message.body} />
      {message.citations.length > 0 ? (
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          {message.citations.length} grounded claim{message.citations.length === 1 ? "" : "s"} cited.
        </p>
      ) : null}
    </fieldset>
  );
}

function EmailPreview({
  detail,
  senderName,
  senderAddress,
}: {
  detail: ApprovalDetail;
  senderName: string;
  senderAddress: string;
}): JSX.Element {
  const primary = detail.messages.find((m) => m.touchIndex === 0) ?? detail.messages[0];
  if (!primary) {
    return <p className="muted">This sequence has no messages.</p>;
  }
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--substrate-border, #e2e8f0)" }}>
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: ACCENT,
            color: "#fff",
            fontWeight: 700,
          }}
        >
          {initials(senderName)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {senderName} <span className="muted" style={{ fontWeight: 400 }}>&lt;{senderAddress}&gt;</span>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            To: {detail.prospectName} &lt;{detail.email}&gt;
          </div>
        </div>
      </div>
      <div style={{ padding: "16px" }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{primary.subject}</h2>
        {renderBody(primary.body, primary.citations)}
      </div>
    </div>
  );
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams?: { seq?: string; status?: string; approved?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Approvals</h1>
        <p>Please sign in to review and approve sequences.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Approvals</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const pending = await listPendingSequences(organizationId);
  const statusKey = searchParams?.status?.trim() ?? "";
  const statusMessage = statusKey ? STATUS_MESSAGES[statusKey] ?? "" : "";

  if (pending.length === 0) {
    return (
      <main>
        <h1>Approvals</h1>
        <p>Review the first batch for each new segment. Approve once, and the rest send themselves.</p>
        {statusMessage ? <p className="card" role="status">{statusMessage}</p> : null}
        <EmptyState />
      </main>
    );
  }

  const selectedId = searchParams?.seq?.trim() || pending[0].id;
  const [detail, acknowledged] = await Promise.all([
    getApprovalDetail(organizationId, selectedId),
    isAupAcknowledged(user.id),
  ]);

  const progress = detail
    ? await segmentProgress(organizationId, detail.campaignId, detail.segmentKey)
    : null;

  const senderName = process.env.SDR_SENDER_NAME ?? "Your SDR";
  const senderAddress = process.env.SDR_SENDER_ADDRESS ?? "founder@example.com";

  return (
    <main>
      <h1>Approvals</h1>
      <p>Review the first batch for each new segment. Approve once, and the rest send themselves.</p>

      {statusMessage ? (
        <p className="card" role="status" style={{ borderColor: statusKey === "aup_required" ? "#b45309" : undefined }}>
          {statusMessage}
        </p>
      ) : null}

      {!acknowledged ? (
        <p className="card" role="alert" style={{ borderColor: "#b45309" }}>
          Approval is blocked until the <strong>Acceptable Use Policy</strong> is acknowledged.{" "}
          <Link href="/legal">Review &amp; acknowledge the AUP →</Link>
        </p>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 1fr) minmax(0, 2fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        {/* Left: inbox list of pending sequences */}
        <section>
          <h2 style={{ fontSize: 15 }}>Pending ({pending.length})</h2>
          <ul style={{ padding: 0, margin: 0 }}>
            {pending.map((item) => (
              <SequenceListItem key={item.id} item={item} selected={item.id === selectedId} />
            ))}
          </ul>
        </section>

        {/* Right: full-bleed email preview + sticky action bar */}
        <section>
          {!detail ? (
            <div className="empty">
              <p>Select a sequence from the list to preview it.</p>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <h2 style={{ marginBottom: 2 }}>{detail.prospectName}</h2>
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    {detail.title ?? "—"} · {detail.company} · segment <code>{detail.segmentKey}</code>
                  </p>
                </div>
                {progress ? <ProgressRing approved={progress.approved} threshold={progress.threshold} /> : null}
              </div>

              <EmailPreview detail={detail} senderName={senderName} senderAddress={senderAddress} />

              {/* Inline edit + approve/skip action bar (sticky) */}
              <form action={approveSequenceAction}>
                <input type="hidden" name="sequenceId" value={detail.sequenceId} />
                <h3 style={{ marginBottom: 8 }}>Edit inline</h3>
                {detail.messages.map((m) => (
                  <MessageEditor key={m.id} message={m} />
                ))}

                <div
                  style={{
                    position: "sticky",
                    bottom: 0,
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: "12px 0",
                    background: "var(--substrate-bg, #ffffff)",
                    borderTop: "1px solid var(--substrate-border, #e2e8f0)",
                  }}
                >
                  <button
                    type="submit"
                    disabled={!acknowledged}
                    style={
                      acknowledged
                        ? { background: ACCENT, borderColor: ACCENT, color: "#fff" }
                        : undefined
                    }
                  >
                    Approve &amp; queue
                  </button>
                  <button type="submit" formAction={skipSequenceAction} className="btn secondary">
                    Skip
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Approving saves your edits, queues all {detail.messages.length} touches, and counts toward unlocking the segment.
                  </span>
                </div>
              </form>

              {/* Approve the whole segment at once (optional shortcut). */}
              {detail.campaignId ? (
                <form action={approveSegmentAction} style={{ marginTop: 8 }}>
                  <input type="hidden" name="campaignId" value={detail.campaignId} />
                  <input type="hidden" name="segmentKey" value={detail.segmentKey} />
                  <button type="submit" className="btn secondary" disabled={!acknowledged}>
                    Approve entire segment now
                  </button>
                </form>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
