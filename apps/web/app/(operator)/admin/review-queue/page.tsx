import { redirect } from "next/navigation";
import Link from "next/link";
import { getAdminUser } from "@nexus/admin-console";
import { getTodayAutoHandledCount, listOpenReviewQueue } from "@/lib/sdr/review-resolution";

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

export default async function ReviewQueuePage(): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }

  const auth = { id: String(admin.id), organizationId: String(admin.organizationId), email: admin.email ?? null };
  const [items, autoHandled] = await Promise.all([listOpenReviewQueue(auth), getTodayAutoHandledCount(auth)]);

  return (
    <main>
      <h1>Operator Reply Review Queue</h1>
      <p className="muted">
        Triage low-confidence and edge-case inbound replies. Choose the correct class and final action.
      </p>

      {items.length === 0 ? (
        <section className="empty">
          <p style={{ fontSize: 24, margin: 0 }}>✅</p>
          <h2>Queue is clear — the classifier handled everything today</h2>
          <p className="muted">Auto-handled replies today: {autoHandled}</p>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 2fr 1.5fr", gap: 12 }}>
          <section className="card">
            <h2>Queue ({items.length})</h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {items.map((item) => (
                <li key={item.id} style={{ borderBottom: "1px solid var(--substrate-border, #333)", padding: "8px 0" }}>
                  <Link href={`/admin/review-queue/${item.id}`} className="btn secondary">
                    Open
                  </Link>
                  <p>
                    <strong>{item.prospectName ?? item.prospectEmail ?? "Unknown prospect"}</strong>
                  </p>
                  <p className="muted">
                    Age: {ageLabel(item.createdAt)} • <code>{item.reason}</code>
                  </p>
                  <p className="muted">
                    Guess: {item.classifierGuess ?? "n/a"} ({item.classifierConfidence?.toFixed(2) ?? "n/a"})
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Thread Preview</h2>
            <p className="muted">Select an item to inspect full context and resolve it.</p>
            <p>Shows message body, subject, and classifier rationale on the detail page.</p>
          </section>

          <section className="card">
            <h2>Shortcuts</h2>
            <ul>
              <li>
                <code>j</code> next item
              </li>
              <li>
                <code>k</code> previous item
              </li>
              <li>
                <code>1-4</code> classification preset
              </li>
              <li>
                <code>5-7</code> action preset
              </li>
            </ul>
            <p className="muted">Resolve actions happen on the detail screen.</p>
          </section>
        </div>
      )}
    </main>
  );
}
