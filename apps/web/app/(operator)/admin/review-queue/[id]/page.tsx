import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/admin-console";
import { getReviewQueueItemById } from "@/lib/sdr/review-resolution";

export default async function ReviewQueueDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const auth = { id: String(admin.id), organizationId: String(admin.organizationId), email: admin.email ?? null };
  const item = await getReviewQueueItemById(auth, params.id);

  if (!item) {
    return (
      <main>
        <h1>Review item not found</h1>
        <p className="muted">This queue entry may have been resolved already.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Review Queue Item</h1>
      <p className="muted">Triage thread + classifier output, then resolve.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 2fr 1.4fr", gap: 12 }}>
        <section className="card">
          <h2>Queue Meta</h2>
          <p><strong>Reason:</strong> <code>{item.reason}</code></p>
          <p><strong>Status:</strong> {item.status}</p>
          <p><strong>Guess:</strong> {item.classifierGuess ?? "n/a"}</p>
          <p><strong>Confidence:</strong> {item.classifierConfidence?.toFixed(2) ?? "n/a"}</p>
        </section>

        <section className="card">
          <h2>Thread</h2>
          <p><strong>Prospect:</strong> {item.prospectName ?? "Unknown"} ({item.prospectEmail ?? "no email"})</p>
          <p><strong>Company:</strong> {item.companyName ?? "n/a"}</p>
          <p><strong>Subject:</strong> {item.subject ?? "(no subject)"}</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{item.bodyText ?? "(empty body)"}</pre>
        </section>

        <section className="card">
          <h2>Decision</h2>
          <form action={`/admin/api/review-queue/${item.id}/resolve`} method="post">
            <label htmlFor="correctedClassification">Classification</label>
            <select id="correctedClassification" name="correctedClassification" defaultValue="unclear">
              <option value="interested">Interested</option>
              <option value="not_interested">Not Interested</option>
              <option value="objection">Objection</option>
              <option value="legal_threat">Legal Threat</option>
              <option value="unclear">Unclear</option>
              <option value="meeting_request">Meeting Request</option>
              <option value="unsubscribe">Unsubscribe</option>
            </select>

            <label htmlFor="action">Action</label>
            <select id="action" name="action" defaultValue="hand_to_customer">
              <option value="send_drafted_touch">Send drafted touch</option>
              <option value="close">Close</option>
              <option value="suppress">Suppress</option>
              <option value="hand_to_customer">Hand to customer</option>
            </select>

            <label htmlFor="notes">Notes</label>
            <textarea id="notes" name="notes" rows={6} placeholder="What did you decide and why?" />

            <button type="submit">Resolve</button>
          </form>

          <hr />
          <p className="muted">
            Keyboard: j/k navigate • 1-7 set classification/action • Enter resolve
          </p>
        </section>
      </div>
    </main>
  );
}
