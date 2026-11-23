import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/organizations-and-teams";
import { getReviewThreadById } from "@/lib/sdr/review-resolution";

interface PageProps {
  params: { id: string };
}

const CLASS_OPTIONS = [
  "positive_interest",
  "not_interested",
  "objection",
  "unsubscribe",
  "out_of_office",
  "referral",
  "legal_threat",
] as const;

const ACTION_OPTIONS = ["send_drafted_touch", "close", "suppress", "hand_to_customer"] as const;

export default async function ReviewQueueDetailPage({ params }: PageProps): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }

  const organizationId = String((admin as { organizationId?: string }).organizationId ?? "");
  if (!organizationId) {
    redirect("/");
  }

  const detail = await getReviewThreadById(organizationId, params.id);
  if (!detail) {
    return (
      <main>
        <h1>Review not found</h1>
      </main>
    );
  }

  return (
    <main>
      <h1>Review queue item</h1>
      <p>
        Reason: <strong>{detail.reason}</strong> · Guess:{" "}
        <strong>{detail.classifierGuess ?? "—"}</strong> · Confidence:{" "}
        <strong>{detail.classifierConfidence !== null ? `${Math.round(detail.classifierConfidence * 100)}%` : "—"}</strong>
      </p>

      <section className="card">
        <h2>Thread</h2>
        {detail.messages.map((message) => (
          <article key={message.id} className="card">
            <p>
              <strong>{message.direction}</strong> · {message.sentAt ?? message.createdAt}
            </p>
            <p>
              <strong>{message.subject ?? "(no subject)"}</strong>
            </p>
            <p>{message.bodyText ?? "—"}</p>
          </article>
        ))}
      </section>

      <section className="card">
        <h2>Decision</h2>
        <form method="post" action={`/admin/api/review-queue/${detail.id}/resolve`}>
          <label htmlFor="correctedClassification">Classification</label>
          <select id="correctedClassification" name="correctedClassification" defaultValue={detail.classifierGuess ?? "objection"}>
            {CLASS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>

          <fieldset>
            <legend>Action</legend>
            {ACTION_OPTIONS.map((option) => (
              <label key={option}>
                <input type="radio" name="action" value={option} defaultChecked={option === "close"} />
                {option}
              </label>
            ))}
          </fieldset>

          <label htmlFor="notes">Notes</label>
          <textarea id="notes" name="notes" rows={4} />

          <button type="submit">Resolve</button>
        </form>
      </section>

      <p className="muted">Shortcuts: j/k navigate queue • 1-7 classification</p>
    </main>
  );
}
