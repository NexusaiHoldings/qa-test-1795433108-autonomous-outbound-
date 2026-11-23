/**
 * Prospects list (F1-004).
 *
 * Card rows — avatar initials, name + title, company with domain favicon, signal
 * chips colored by type, status pill, fit-score bar — with faceted filters
 * (status / campaign / free-text search). Empty state shows a radar-sweep cue:
 * "Your first prospects land within 10 minutes of saving a campaign."
 *
 * Server component (no 'use client'): all data is loaded server-side and
 * filters round-trip through the URL query string.
 */

import type { JSX } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import {
  listProspects,
  prospectStatusCounts,
  PROSPECT_STATUSES,
  type ProspectRecord,
} from "@/lib/sdr/sourcing";
import { listSignalsForProspects, type SignalRecord, type SignalType } from "@/lib/sdr/signal-enrichment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNAL_COLORS: Record<SignalType, string> = {
  funding: "#15803d",
  hiring_surge: "#b45309",
  leadership_change: "#6d28d9",
  new_office: "#0369a1",
  news_mention: "#64748b",
  apollo_intent: "#be185d",
};

const SIGNAL_LABELS: Record<SignalType, string> = {
  funding: "Funding",
  hiring_surge: "Hiring surge",
  leadership_change: "Leadership change",
  new_office: "New office",
  news_mention: "News",
  apollo_intent: "Intent",
};

const STATUS_LABELS: Record<string, string> = {
  sourced: "Sourced",
  sequenced: "Sequenced",
  contacted: "Contacted",
  replied: "Replied",
  meeting_booked: "Meeting booked",
  closed: "Closed",
  suppressed: "Suppressed",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ name }: { name: string }): JSX.Element {
  return (
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
        color: "var(--substrate-text, #0f172a)",
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials(name)}
    </span>
  );
}

function SignalChip({ signal }: { signal: SignalRecord }): JSX.Element {
  const color = SIGNAL_COLORS[signal.type];
  return (
    <span
      title={signal.headline}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        marginRight: 6,
        marginTop: 4,
      }}
    >
      {SIGNAL_LABELS[signal.type]}
    </span>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        border: "1px solid var(--substrate-border, #cbd5e1)",
        background: "var(--substrate-surface-2, #f1f5f9)",
      }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function FitBar({ score }: { score: number }): JSX.Element {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div style={{ minWidth: 120 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        Fit {pct}
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: "var(--substrate-surface-2, #e2e8f0)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pct >= 70 ? "#15803d" : pct >= 40 ? "#b45309" : "#64748b",
          }}
        />
      </div>
    </div>
  );
}

function ProspectCard({
  prospect,
  signals,
}: {
  prospect: ProspectRecord;
  signals: SignalRecord[];
}): JSX.Element {
  const favicon = prospect.companyDomain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(prospect.companyDomain)}&sz=32`
    : null;

  return (
    <article className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Avatar name={prospect.fullName} />
        <div style={{ flex: "1 1 240px", minWidth: 220 }}>
          <Link href={`/prospects/${prospect.id}`} style={{ fontWeight: 600, fontSize: 16 }}>
            {prospect.fullName}
          </Link>
          <div className="muted">{prospect.title ?? "—"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            {favicon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={favicon} alt="" width={16} height={16} style={{ borderRadius: 3 }} />
            ) : null}
            <span>{prospect.companyName ?? "Unknown company"}</span>
            {prospect.companyDomain ? (
              <span className="muted" style={{ fontSize: 12 }}>
                {prospect.companyDomain}
              </span>
            ) : null}
          </div>
          <div>
            {signals.length === 0 ? (
              <span className="muted" style={{ fontSize: 12 }}>
                No signals yet
              </span>
            ) : (
              signals.slice(0, 4).map((s) => <SignalChip key={s.id} signal={s} />)
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <StatusPill status={prospect.status} />
          <FitBar score={prospect.fitScore} />
        </div>
      </div>
    </article>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="empty">
      <svg
        width="96"
        height="96"
        viewBox="0 0 96 96"
        fill="none"
        aria-hidden="true"
        style={{ marginBottom: 12 }}
      >
        <circle cx="48" cy="48" r="40" stroke="currentColor" strokeOpacity="0.25" />
        <circle cx="48" cy="48" r="26" stroke="currentColor" strokeOpacity="0.25" />
        <circle cx="48" cy="48" r="12" stroke="currentColor" strokeOpacity="0.25" />
        <path d="M48 48 L48 8" stroke="currentColor" strokeOpacity="0.6" strokeWidth="2" />
        <path d="M48 48 L82 62" stroke="currentColor" strokeOpacity="0.6" strokeWidth="2" />
        <circle cx="68" cy="34" r="3" fill="currentColor" />
      </svg>
      <p>
        <strong>No prospects yet.</strong>
      </p>
      <p className="muted">Your first prospects land within 10 minutes of saving a campaign.</p>
    </div>
  );
}

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams?: { status?: string; q?: string; campaign?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Prospects</h1>
        <p>Please sign in to view your sourced prospects.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Prospects</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const status = searchParams?.status?.trim() || "";
  const search = searchParams?.q?.trim() || "";
  const campaign = searchParams?.campaign?.trim() || "";

  const [prospects, counts] = await Promise.all([
    listProspects({
      organizationId,
      status: status || undefined,
      campaignId: campaign || undefined,
      search: search || undefined,
    }),
    prospectStatusCounts(organizationId),
  ]);

  const signalMap = await listSignalsForProspects(
    organizationId,
    prospects.map((p) => p.id),
  );
  const totalProspects = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <main>
      <h1>Prospects</h1>
      <p>
        Apollo-sourced buyers, validated against your suppression ledger and US-only guard, ranked by
        buying-signal fit.
      </p>

      <form className="toolbar" method="get" action="/prospects">
        <input
          type="search"
          name="q"
          placeholder="Search name, title, company, email"
          defaultValue={search}
          aria-label="Search prospects"
        />
        <select name="status" defaultValue={status} aria-label="Filter by status">
          <option value="">All statuses ({totalProspects})</option>
          {PROSPECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]} ({counts[s] ?? 0})
            </option>
          ))}
        </select>
        {campaign ? <input type="hidden" name="campaign" value={campaign} /> : null}
        <button type="submit">Search</button>
        {status || search || campaign ? (
          <Link className="btn secondary" href="/prospects">
            Clear
          </Link>
        ) : null}
      </form>

      {prospects.length === 0 ? (
        totalProspects === 0 ? (
          <EmptyState />
        ) : (
          <div className="empty">
            <p>No prospects match these filters.</p>
            <p className="muted">
              <Link href="/prospects">Clear filters</Link> to see all {totalProspects}.
            </p>
          </div>
        )
      ) : (
        <section>
          <p className="muted">
            Showing {prospects.length} prospect{prospects.length === 1 ? "" : "s"}
          </p>
          {prospects.map((prospect) => (
            <ProspectCard
              key={prospect.id}
              prospect={prospect}
              signals={signalMap.get(prospect.id) ?? []}
            />
          ))}
        </section>
      )}
    </main>
  );
}
