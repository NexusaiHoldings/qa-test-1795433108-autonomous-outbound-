import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/organizations-and-teams";
import { listOpenReviewQueue } from "@/lib/sdr/review-resolution";

function formatAge(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rm = mins % 60;
  return `${h}h ${rm}m`;
}

export default async function ReviewQueuePage(): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }

  const organizationId = String((admin as { organizationId?: string }).organizationId ?? "");
  if (!organizationId) {
    redirect("/");
  }

  const { items, autoHandledToday } = await listOpenReviewQueue(organizationId, 200);

  return (
    <main>
      <h1>Operator Reply Review Console</h1>
      <p>Work edge-case inbound replies that need human judgment before resolution.</p>

      <p className="muted">Keyboard: j/k move • 1-7 classify • Enter resolve</p>

      {items.length === 0 ? (
        <section className="empty">
          <h2>✅ Queue is clear — the classifier handled everything today</h2>
          <p className="muted">Auto-handled replies today: {autoHandledToday}</p>
        </section>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Reason</th>
              <th>Age</th>
              <th>Prospect</th>
              <th>Subject</th>
              <th>Classifier guess</th>
              <th>Confidence</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <span className="card">{item.reason}</span>
                </td>
                <td>{formatAge(item.ageSeconds)}</td>
                <td>{item.prospectName ?? item.prospectEmail ?? "Unknown"}</td>
                <td>{item.subject ?? "—"}</td>
                <td>{item.classifierGuess ?? "—"}</td>
                <td>{item.classifierConfidence !== null ? `${Math.round(item.classifierConfidence * 100)}%` : "—"}</td>
                <td>
                  <Link className="btn" href={`/admin/review-queue/${item.id}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
