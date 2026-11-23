/**
 * /mailbox — Founder Mailbox Sender health card (F1-006).
 *
 * The single surface the founder checks to trust that sends are safe. When no
 * mailbox is connected it shows an inviting connect state (primary "Connect
 * Google Workspace", secondary Outlook). Once connected it is one health card:
 *   - a large circular "sending health" gauge,
 *   - three DNS status rows (SPF / DKIM / DMARC) with green/amber pills and a
 *     fix-it drawer (<details>),
 *   - the warmup stage as a horizontal stepper (20 → 40 → 80/day),
 *   - today's sends as a progress bar against the daily cap.
 *
 * Server component — all data loaded server-side; the only interactivity is the
 * native <details> drawers and the server-action forms.
 */

import type { JSX } from "react";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import {
  getPrimaryMailbox,
  computeMailboxHealth,
  getMailboxDnsDetail,
  capForStage,
  WARMUP_CAPS,
  type MailboxRecord,
  type MailboxHealth,
  type MailboxDnsDetail,
  type DnsDetailNote,
} from "@/lib/sdr/send-dispatcher";
import {
  connectGmailAction,
  connectOutlookAction,
  pauseMailboxAction,
  resumeMailboxAction,
  recheckDnsAction,
  advanceWarmupAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_MESSAGES: Record<string, string> = {
  connected: "Mailbox connected. Running DNS and deliverability checks.",
  connect_failed: "Could not connect that mailbox. Check the account and try again.",
  paused: "Sending paused. No touches will go out until you resume.",
  resumed: "Sending resumed.",
  dns_rechecked: "DNS records re-checked.",
  warmup_advanced: "Warmup advanced to the next daily cap.",
  unauthorized: "Please sign in to manage your sending mailbox.",
  no_org: "No active organization selected.",
  missing_mailbox: "Could not resolve that mailbox.",
};

function healthColor(score: number): string {
  if (score >= 80) return "#16a34a";
  if (score >= 55) return "#d97706";
  return "#dc2626";
}

/** A large circular gauge rendered as inline SVG (no client JS). */
function HealthGauge({ score }: { score: number }): JSX.Element {
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const dash = (clamped / 100) * circumference;
  const color = healthColor(clamped);
  return (
    <svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label={`Sending health ${clamped} of 100`}>
      <circle cx="90" cy="90" r={radius} fill="none" stroke="#e5e7eb" strokeWidth="14" />
      <circle
        cx="90"
        cy="90"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="14"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference - dash}`}
        transform="rotate(-90 90 90)"
      />
      <text x="90" y="84" textAnchor="middle" fontSize="40" fontWeight="700" fill={color}>
        {clamped}
      </text>
      <text x="90" y="110" textAnchor="middle" fontSize="13" fill="#6b7280">
        sending health
      </text>
    </svg>
  );
}

function Pill({ ok }: { ok: boolean }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: ok ? "#065f46" : "#92400e",
        background: ok ? "#d1fae5" : "#fef3c7",
      }}
    >
      {ok ? "Passing" : "Action needed"}
    </span>
  );
}

function DnsRow({ label, ok, detail }: { label: string; ok: boolean; detail: DnsDetailNote }): JSX.Element {
  return (
    <details className="card" style={{ marginBottom: 8 }}>
      <summary style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <strong>{label}</strong>
        <Pill ok={ok} />
      </summary>
      <p className="muted" style={{ margin: "8px 0 4px" }}>
        {detail.note}
      </p>
      {detail.record ? (
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12, margin: 0 }}>{detail.record}</pre>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          No record found. Publish the record above at your DNS provider, then re-check.
        </p>
      )}
    </details>
  );
}

/** Horizontal warmup stepper: 20 → 40 → 80/day. */
function WarmupStepper({ stage }: { stage: number }): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {WARMUP_CAPS.map((cap, i) => {
        const done = i < stage;
        const current = i === stage;
        const active = done || current;
        return (
          <div key={cap} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                opacity: active ? 1 : 0.5,
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  color: active ? "#fff" : "#6b7280",
                  background: current ? "#4f46e5" : done ? "#16a34a" : "#e5e7eb",
                }}
              >
                {i + 1}
              </div>
              <span style={{ fontSize: 12 }}>{cap}/day</span>
            </div>
            {i < WARMUP_CAPS.length - 1 ? (
              <div style={{ width: 28, height: 2, background: done ? "#16a34a" : "#e5e7eb" }} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SendProgress({ sent, cap }: { sent: number; cap: number }): JSX.Element {
  const pct = cap > 0 ? Math.min(100, Math.round((sent / cap) * 100)) : 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
        <span>Today&apos;s sends</span>
        <span className="muted">
          {sent} / {cap}
        </span>
      </div>
      <div style={{ height: 12, borderRadius: 999, background: "#e5e7eb", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "#d97706" : "#4f46e5" }} />
      </div>
    </div>
  );
}

function ConnectState(): JSX.Element {
  return (
    <section className="card" style={{ textAlign: "center", padding: 32 }}>
      <div aria-hidden="true" style={{ fontSize: 56, lineHeight: 1 }}>
        📬
      </div>
      <h2 style={{ marginTop: 12 }}>Send from the inbox you already live in</h2>
      <p className="muted" style={{ maxWidth: 440, margin: "6px auto 20px" }}>
        Connect your own mailbox so every touch goes out as you — your customers reply to you, and
        you stay the CAN-SPAM sender. We only ever send on your behalf.
      </p>
      <form action={connectGmailAction} style={{ display: "inline-block" }}>
        <input type="hidden" name="physicalAddress" value="" />
        <button type="submit">Connect Google Workspace</button>
      </form>
      <div style={{ marginTop: 12 }}>
        <form action={connectOutlookAction} style={{ display: "inline-block" }}>
          <button type="submit" className="btn secondary">
            Connect Outlook instead
          </button>
        </form>
      </div>
    </section>
  );
}

function HealthCard({
  mailbox,
  health,
  dns,
}: {
  mailbox: MailboxRecord;
  health: MailboxHealth;
  dns: MailboxDnsDetail;
}): JSX.Element {
  const paused = mailbox.status === "paused";
  const canAdvance = mailbox.warmupStage < WARMUP_CAPS.length - 1 && mailbox.spfOk && mailbox.dkimOk && mailbox.dmarcOk;
  return (
    <section className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>{mailbox.email}</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {mailbox.provider === "outlook" ? "Outlook / Microsoft 365" : "Google Workspace"} ·{" "}
            {paused ? "Paused" : "Sending"}
          </p>
        </div>
        {paused ? (
          <form action={resumeMailboxAction}>
            <input type="hidden" name="mailboxId" value={mailbox.id} />
            <button type="submit">Resume sending</button>
          </form>
        ) : (
          <form action={pauseMailboxAction}>
            <input type="hidden" name="mailboxId" value={mailbox.id} />
            <input type="hidden" name="reason" value="Paused by founder" />
            <button type="submit" className="btn secondary">
              Pause sending
            </button>
          </form>
        )}
      </div>

      {paused && mailbox.pauseReason ? (
        <p style={{ color: "#dc2626", marginTop: 8 }}>{mailbox.pauseReason}</p>
      ) : null}

      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", marginTop: 16 }}>
        <HealthGauge score={health.score} />
        <div style={{ flex: "1 1 260px", minWidth: 240 }}>
          <SendProgress sent={health.sentToday} cap={health.dailyCap} />
          <ul style={{ marginTop: 12, listStyle: "none", padding: 0 }}>
            <li>DNS authentication: {health.dnsScore}/100</li>
            <li>Reputation (30-day bounce/complaint): {health.reputationScore}/100</li>
            <li>Warmup progress: {health.warmupScore}/100</li>
            <li className="muted">
              {health.totalSent30d} sent · {(health.bounceRate * 100).toFixed(1)}% bounced ·{" "}
              {(health.complaintRate * 100).toFixed(2)}% complaints (30d)
            </li>
          </ul>
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>Warmup stage</h3>
      <WarmupStepper stage={mailbox.warmupStage} />
      {canAdvance ? (
        <form action={advanceWarmupAction} style={{ marginTop: 12 }}>
          <input type="hidden" name="mailboxId" value={mailbox.id} />
          <button type="submit" className="btn secondary">
            Advance to {capForStage(mailbox.warmupStage + 1)}/day
          </button>
        </form>
      ) : (
        <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          {mailbox.warmupStage >= WARMUP_CAPS.length - 1
            ? "Fully warmed up."
            : "All DNS checks must pass before advancing the warmup cap."}
        </p>
      )}

      <h3 style={{ marginTop: 24 }}>Domain authentication</h3>
      <DnsRow label="SPF" ok={mailbox.spfOk} detail={dns.spf} />
      <DnsRow label="DKIM" ok={mailbox.dkimOk} detail={dns.dkim} />
      <DnsRow label="DMARC" ok={mailbox.dmarcOk} detail={dns.dmarc} />
      <form action={recheckDnsAction} style={{ marginTop: 8 }}>
        <input type="hidden" name="mailboxId" value={mailbox.id} />
        <button type="submit" className="btn secondary">
          Re-check DNS
        </button>
      </form>
    </section>
  );
}

export default async function MailboxPage({
  searchParams,
}: {
  searchParams?: { status?: string; reason?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user?.id) {
    return (
      <main>
        <h1>Sending mailbox</h1>
        <p>Please sign in to connect and monitor your sending mailbox.</p>
      </main>
    );
  }

  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Sending mailbox</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const mailbox = await getPrimaryMailbox(organizationId);
  const statusKey = searchParams?.status;
  const statusMessage = statusKey ? STATUS_MESSAGES[statusKey] : undefined;

  let health: MailboxHealth | null = null;
  let dns: MailboxDnsDetail | null = null;
  if (mailbox) {
    [health, dns] = await Promise.all([
      computeMailboxHealth(organizationId, mailbox),
      getMailboxDnsDetail(organizationId, mailbox.id),
    ]);
  }

  return (
    <main>
      <h1>Sending mailbox</h1>
      <p>
        The &apos;send&apos; verb runs from your own inbox, so your customers — not us — are the
        sender, and replies land where you already work.
      </p>

      {statusMessage ? (
        <p className="card" style={{ background: statusKey === "connect_failed" ? "#fef2f2" : undefined }}>
          {statusMessage}
        </p>
      ) : null}

      {mailbox && health && dns ? (
        <HealthCard mailbox={mailbox} health={health} dns={dns} />
      ) : (
        <ConnectState />
      )}
    </main>
  );
}
