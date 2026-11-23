import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { getReviewThreadById } from "@/lib/sdr/review-resolution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { id: string };
  searchParams?: { error?: string };
}

const REASON_LABELS: Record<string, string> = {
  unclear: "Unclear",
  low_confidence: "Low confidence",
  legal_threat: "Legal threat",
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid_payload: "Pick both a classification and an action before resolving.",
  admin_context_incomplete: "Your operator account is missing an active organization.",
  review_not_found: "That review item no longer exists.",
  already_resolved: "Another operator already resolved this item.",
  resolve_failed: "Could not record the decision — please try again.",
};

const CLASS_OPTIONS: { value: string; label: string }[] = [
  { value: "positive_interest", label: "Positive interest" },
  { value: "not_interested", label: "Not interested" },
  { value: "objection", label: "Objection" },
  { value: "unsubscribe", label: "Unsubscribe" },
  { value: "out_of_office", label: "Out of office" },
  { value: "referral", label: "Referral" },
  { value: "legal_threat", label: "Legal threat" },
];

const ACTION_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "send_drafted_touch", label: "Send drafted touch", hint: "Continue the sequence" },
  { value: "close", label: "Close", hint: "No further action" },
  { value: "suppress", label: "Suppress", hint: "Add to do-not-contact" },
  { value: "hand_to_customer", label: "Hand to customer", hint: "Escalate to the founder" },
];

function formatAge(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export default async function ReviewQueueDetailPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }

  const organizationId = await getActiveOrganizationId(admin.id);
  if (!organizationId) {
    redirect("/admin/review-queue");
  }

  const detail = await getReviewThreadById(organizationId, params.id);
  if (!detail) {
    return (
      <main>
        <h1>Review item not found</h1>
        <p>This item was resolved or never existed.</p>
        <Link className="btn secondary" href="/admin/review-queue">
          Back to queue
        </Link>
      </main>
    );
  }

  const errorKey = searchParams?.error;
  const errorMessage = errorKey ? ERROR_MESSAGES[errorKey] ?? "Could not record the decision." : null;
  const defaultClass = detail.classifierGuess ?? "objection";
  const confidencePct =
    detail.classifierConfidence !== null ? `${Math.round(detail.classifierConfidence * 100)}%` : "—";

  return (
    <main>
      <p className="muted">
        <Link href="/admin/review-queue">← Back to queue</Link>
      </p>

      <h1>Triage reply</h1>
      <p>
        <span className="card" style={{ padding: "0.15rem 0.45rem" }}>
          {REASON_LABELS[detail.reason] ?? detail.reason}
        </span>{" "}
        · {detail.prospectName ?? detail.prospectEmail ?? "Unknown prospect"} · waiting{" "}
        {formatAge(detail.ageSeconds)}
      </p>

      <p className="muted">
        Classifier guessed <strong>{detail.classifierGuess ?? "—"}</strong> at{" "}
        <strong>{confidencePct}</strong> confidence.
      </p>

      {errorMessage ? (
        <p className="card" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <section className="card">
        <h2>Conversation</h2>
        {detail.messages.length === 0 ? (
          <p className="muted">No messages found for this thread.</p>
        ) : (
          detail.messages.map((message) => (
            <article key={message.id} className="card">
              <p className="muted">
                <strong>{message.direction === "inbound" ? "Prospect" : "Us"}</strong> ·{" "}
                {message.sentAt ?? message.createdAt}
              </p>
              <p>
                <strong>{message.subject ?? "(no subject)"}</strong>
              </p>
              <p style={{ whiteSpace: "pre-wrap" }}>{message.bodyText ?? "—"}</p>
            </article>
          ))
        )}
      </section>

      <section className="card">
        <h2>Decision</h2>
        <form method="post" action={`/admin/api/review-queue/${detail.id}/resolve`}>
          <fieldset>
            <legend>Correct classification</legend>
            {CLASS_OPTIONS.map((option, index) => (
              <label key={option.value} style={{ display: "block" }}>
                <input
                  type="radio"
                  name="correctedClassification"
                  value={option.value}
                  defaultChecked={option.value === defaultClass}
                  required
                />{" "}
                <strong>{index + 1}</strong> · {option.label}
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>Action</legend>
            {ACTION_OPTIONS.map((option) => (
              <label key={option.value} style={{ display: "block" }}>
                <input
                  type="radio"
                  name="action"
                  value={option.value}
                  defaultChecked={option.value === "close"}
                  required
                />{" "}
                {option.label} <span className="muted">— {option.hint}</span>
              </label>
            ))}
          </fieldset>

          <label htmlFor="notes">Notes (optional)</label>
          <textarea id="notes" name="notes" rows={4} placeholder="Context for the labeled corpus…" />

          <button type="submit">Resolve</button>
        </form>
      </section>

      <p className="muted">
        Shortcuts: <strong>1–7</strong> select classification · <strong>Enter</strong> resolve. Every
        decision is written to the labeled corpus for the evaluation harness.
      </p>
    </main>
  );
}
