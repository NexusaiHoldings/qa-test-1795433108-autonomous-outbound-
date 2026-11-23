import { getServerSession } from "@nexus/identity-and-access";
import { getActiveOrganizationContext } from "@nexus/organizations-and-teams";
import { getSuppressionStats, listSuppressions, SUPPRESSION_REASONS } from "@/lib/sdr/suppression";
import { addDomainSuppressionAction, uploadSuppressionCsvAction } from "./actions";

export default async function CompliancePage({
  searchParams,
}: {
  searchParams?: { reason?: string };
}): Promise<JSX.Element> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return (
      <main>
        <h1>Compliance</h1>
        <p>Please sign in to manage suppression and unsubscribe settings.</p>
      </main>
    );
  }

  const org = await getActiveOrganizationContext({ userId: session.user.id });
  if (!org?.organizationId) {
    return (
      <main>
        <h1>Compliance</h1>
        <p>No active organization selected.</p>
      </main>
    );
  }

  const reason = searchParams?.reason?.trim() || "";
  const [stats, suppressions] = await Promise.all([
    getSuppressionStats(org.organizationId),
    listSuppressions(org.organizationId, reason || undefined),
  ]);

  const senderAddress = process.env.SDR_SENDER_ADDRESS ?? "founder@example.com";

  return (
    <main>
      <h1>Compliance & Suppression</h1>
      <p>Honor opt-outs immediately, enforce US-only outreach, and keep your do-not-contact ledger audit-ready.</p>

      <section className="toolbar" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
        <article className="card">
          <h2>Suppressed contacts</h2>
          <p><strong>{stats.suppressedContacts}</strong></p>
        </article>
        <article className="card">
          <h2>Unsubscribes honored this month</h2>
          <p><strong>{stats.unsubscribesHonoredThisMonth}</strong></p>
        </article>
        <article className="card">
          <h2>Median time-to-honor</h2>
          <p><strong>{stats.medianTimeToHonorSeconds}s</strong></p>
        </article>
      </section>

      <section className="card">
        <h2>Sender footer address</h2>
        <p className="muted">This address appears in every outbound footer.</p>
        <p><strong>{senderAddress}</strong></p>
      </section>

      <section className="card">
        <h2>Upload do-not-contact CSV</h2>
        <form action={uploadSuppressionCsvAction}>
          <label htmlFor="csv_text">CSV contents</label>
          <textarea id="csv_text" name="csv_text" rows={8} placeholder="email&#10;jane@acme.com&#10;ops@globex.com" required />
          <button type="submit">Upload suppression CSV</button>
        </form>
      </section>

      <section className="card">
        <h2>Add suppressed domain</h2>
        <form action={addDomainSuppressionAction}>
          <label htmlFor="domain">Domain</label>
          <input id="domain" name="domain" placeholder="example.com" required />
          <button type="submit">Add domain suppression</button>
        </form>
      </section>

      <section>
        <h2>Suppression ledger</h2>
        <form className="toolbar" method="get">
          <label htmlFor="reason">Reason</label>
          <select id="reason" name="reason" defaultValue={reason}>
            <option value="">All reasons</option>
            {SUPPRESSION_REASONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button type="submit">Filter</button>
        </form>

        {suppressions.length === 0 ? (
          <div className="empty">
            <p>No one has asked to stop hearing from you — your sequences will add anyone who does, automatically.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Email</th>
                <th>Domain</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {suppressions.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.email ?? "—"}</td>
                  <td>{row.domain ?? "—"}</td>
                  <td><span className="card" style={{ padding: "0.15rem 0.45rem" }}>{row.reason}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
