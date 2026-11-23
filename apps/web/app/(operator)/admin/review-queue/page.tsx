import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { listOpenReviewQueue } from "@/lib/sdr/review-resolution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REASON_LABELS: Record<string, string> = {
  unclear: "Unclear",
  low_confidence: "Low confidence",
  legal_threat: "Legal threat",
};

function formatAge(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams?: { resolved?: string };
}): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }

  const organizationId = await getActiveOrganizationId(admin.id);
  if (!organizationId) {
    return (
      <main>
        <h1>Operator Reply Review Console</h1>
        <p>No active organization is selected for your operator account.</p>
      </main>
    );
  }

  const { items, autoHandledToday } = await listOpenReviewQueue(organizationId, 200);
  const justResolved = searchParams?.resolved === "1";

  return (
    <main>
      <h1>Operator Reply Review Console</h1>
      <p>
        Work the edge-case inbound replies the classifier flagged — unclear, low-confidence, or a
        legal threat — and record the correct class and action for every one.
      </p>

      {justResolved ? (
        <p className="card" role="status">
          Decision recorded. The next item is ready below.
        </p>
      ) : null}

      <p className="muted">
        Keyboard: <strong>j</strong>/<strong>k</strong> move · <strong>1–7</strong> pick class ·{" "}
        <strong>Enter</strong> resolve. Open an item to triage the thread.
      </p>

      {items.length === 0 ? (
        <section className="empty">
          <h2>✓ Queue is clear — the classifier handled everything today</h2>
          <p className="muted">
            {autoHandledToday} repl{autoHandledToday === 1 ? "y" : "ies"} auto-handled today without
            an operator.
          </p>
        </section>
      ) : (
        <>
          <p className="muted">
            {items.length} item{items.length === 1 ? "" : "s"} waiting · {autoHandledToday}{" "}
            auto-handled today
          </p>
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th>Age</th>
                <th>Prospect</th>
                <th>Subject</th>
                <th>Classifier guess</th>
                <th>Confidence</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="card" style={{ padding: "0.15rem 0.45rem" }}>
                      {REASON_LABELS[item.reason] ?? item.reason}
                    </span>
                  </td>
                  <td>{formatAge(item.ageSeconds)}</td>
                  <td>{item.prospectName ?? item.prospectEmail ?? "Unknown"}</td>
                  <td>{item.subject ?? "—"}</td>
                  <td>{item.classifierGuess ?? "—"}</td>
                  <td>
                    {item.classifierConfidence !== null
                      ? `${Math.round(item.classifierConfidence * 100)}%`
                      : "—"}
                  </td>
                  <td>
                    <Link className="btn" href={`/admin/review-queue/${item.id}`}>
                      Triage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
