/**
 * Prospect detail (F1-004).
 *
 * Left profile column (identity, company, fit) + right timeline of trigger
 * signals rendered as a vertical stepper with source links. Below the timeline,
 * the planned outreach sequence previews the cadence this prospect will enter,
 * personalized with its strongest signal. Server component — no client JS.
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { getProspect } from "@/lib/sdr/sourcing";
import { listProspectSignals, type SignalRecord, type SignalType } from "@/lib/sdr/signal-enrichment";

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
  news_mention: "News mention",
  apollo_intent: "Apollo intent",
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

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

type SequenceStep = { day: number; label: string; preview: string };

function plannedSequence(fullName: string, topSignal: SignalRecord | null): SequenceStep[] {
  const firstName = fullName.split(/\s+/)[0] || "there";
  const hook = topSignal
    ? `Saw that ${topSignal.headline.toLowerCase()} — `
    : "";
  return [
    {
      day: 0,
      label: "Intro email",
      preview: `${hook}opening with a relevant, specific reason to reach out to ${firstName}.`,
    },
    {
      day: 3,
      label: "Value follow-up",
      preview: "Share a concrete proof point / case study tied to the signal above.",
    },
    {
      day: 7,
      label: "Break-up",
      preview: "Short, polite last touch inviting a reply or an opt-out.",
    },
  ];
}

function SignalStep({ signal, isLast }: { signal: SignalRecord; isLast: boolean }): JSX.Element {
  const color = SIGNAL_COLORS[signal.type];
  return (
    <li style={{ display: "flex", gap: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
            marginTop: 4,
          }}
        />
        {!isLast ? (
          <span
            aria-hidden="true"
            style={{ flex: 1, width: 2, background: "var(--substrate-border, #cbd5e1)", marginTop: 2 }}
          />
        ) : null}
      </div>
      <div style={{ paddingBottom: 20 }}>
        <span style={{ color, fontWeight: 600, fontSize: 13 }}>{SIGNAL_LABELS[signal.type]}</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {formatDate(signal.observedAt)} · weight {signal.weight}
        </span>
        <p style={{ margin: "4px 0 0" }}>{signal.headline}</p>
        {signal.sourceUrl ? (
          <a href={signal.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 13 }}>
            View source →
          </a>
        ) : null}
      </div>
    </li>
  );
}

export default async function ProspectDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Prospect</h1>
        <p>Please sign in to view this prospect.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Prospect</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const prospect = await getProspect(organizationId, params.id);
  if (!prospect) {
    notFound();
  }

  const signals = await listProspectSignals(organizationId, prospect.id);
  const topSignal =
    signals.length > 0 ? [...signals].sort((a, b) => b.weight - a.weight)[0] : null;
  const sequence = plannedSequence(prospect.fullName, topSignal);

  const favicon = prospect.companyDomain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(prospect.companyDomain)}&sz=32`
    : null;

  return (
    <main>
      <p>
        <Link href="/prospects">← Back to prospects</Link>
      </p>
      <h1>{prospect.fullName}</h1>
      <p>{prospect.title ?? "—"}</p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(240px, 1fr) minmax(0, 2fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        {/* Left profile column */}
        <aside className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 48,
                height: 48,
                borderRadius: "50%",
                background: "var(--substrate-surface-2, #e2e8f0)",
                fontWeight: 600,
              }}
            >
              {initials(prospect.fullName)}
            </span>
            <div>
              <div style={{ fontWeight: 600 }}>{prospect.fullName}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {STATUS_LABELS[prospect.status] ?? prospect.status}
              </div>
            </div>
          </div>

          <table>
            <tbody>
              <tr>
                <td className="muted">Company</td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {favicon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={favicon} alt="" width={16} height={16} style={{ borderRadius: 3 }} />
                    ) : null}
                    {prospect.companyName ?? "—"}
                  </span>
                </td>
              </tr>
              <tr>
                <td className="muted">Domain</td>
                <td>{prospect.companyDomain ?? "—"}</td>
              </tr>
              <tr>
                <td className="muted">Email</td>
                <td>{prospect.email}</td>
              </tr>
              <tr>
                <td className="muted">Location</td>
                <td>{[prospect.region, prospect.countryCode].filter(Boolean).join(", ") || "—"}</td>
              </tr>
              <tr>
                <td className="muted">Fit score</td>
                <td>
                  <strong>{prospect.fitScore}</strong> / 100
                </td>
              </tr>
              <tr>
                <td className="muted">Apollo ID</td>
                <td>{prospect.sourceExternalId ?? "—"}</td>
              </tr>
              <tr>
                <td className="muted">Sourced</td>
                <td>{prospect.createdAt ? formatDate(prospect.createdAt) : "—"}</td>
              </tr>
            </tbody>
          </table>
        </aside>

        {/* Right: signal timeline + planned sequence */}
        <section>
          <h2>Signal timeline</h2>
          {signals.length === 0 ? (
            <div className="empty">
              <p>No trigger signals yet.</p>
              <p className="muted">
                Funding, hiring-surge, and leadership-change signals attach automatically as they are
                detected.
              </p>
            </div>
          ) : (
            <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {signals.map((signal, idx) => (
                <SignalStep key={signal.id} signal={signal} isLast={idx === signals.length - 1} />
              ))}
            </ol>
          )}

          <h2>Planned sequence</h2>
          <p className="muted">The cadence this prospect will enter, personalized with its strongest signal.</p>
          <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {sequence.map((step) => (
              <li key={step.day} className="card" style={{ marginBottom: 10 }}>
                <strong>
                  Day {step.day} · {step.label}
                </strong>
                <p style={{ margin: "4px 0 0" }}>{step.preview}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
