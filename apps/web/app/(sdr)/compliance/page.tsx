import { getServerSession } from "@nexus/identity-and-access";
import { getComplianceStats, listSuppressionsByOrg } from "@/lib/sdr/suppression";
import { addSuppressionDomainAction, uploadSuppressionCsvAction } from "./actions";

function getOrganizationId(session: unknown): string {
  const candidate = session as { organizationId?: string; user?: { organizationId?: string; email?: string } };
  return candidate?.organizationId || candidate?.user?.organizationId || "";
}

function getSenderEmail(session: unknown): string {
  const candidate = session as { user?: { email?: string } };
  return candidate?.user?.email || "sender@yourcompany.com";
}

export default async function CompliancePage({
  searchParams,
}: {
  searchParams?: { reason?: string; q?: string };
}): Promise<JSX.Element> {
  const session = await getServerSession();
  const organizationId = getOrganizationId(session);
  const senderEmail = getSenderEmail(session);

  if (!organizationId) {
    return (
      <main>
        <h1>Compliance</h1>
        <p>Please sign in to manage suppression and unsubscribe settings.</p>
      </main>
    );
  }

  const reason = searchParams?.reason || "";
  const query = searchParams?.q || "";

  const [stats, suppressions] = await Promise.all([
    getComplianceStats(organizationId),
    listSuppressionsByOrg({ organizationId, reason: reason || undefined, query: query || undefined }),
  ]);

  return (
    <main>
      <h1>Compliance</h1>
      <p>Manage do-not-contact rules, honor unsubscribes immediately, and enforce US-only outreach.</p>

      <section className="toolbar">
        <div className="card">
          <strong>{stats.suppressedContacts}</strong>
          <p className="muted">Suppressed contacts</p>
        </div>
        <div className="card">
          <strong>{stats.unsubscribesThisMonth}</strong>
          <p className="muted">Unsubscribes honored this month</p>
        </div>
        <div className="card">
          <strong>{stats.medianHonorSeconds}s</strong>
          <p className="muted">Median time-to-honor</p>
        </div>
      </section>

      <section className="card">
        <h2>Sender footer address</h2>
        <p className="muted">This address appears in every sequence footer:</p>
        <p>
          <code>{senderEmail}</code>
        </p>
      </section>

      <section className="card">
        <h2>Add blocked domain</h2>
        <form action={addSuppressionDomainAction}>
          <label htmlFor="domain">Domain</label>
          <input id="domain" name="domain" type="text" placeholder="example.com" required />
          <button type="submit">Add domain</button>
        </form>
      </section>

      <section className="card">
        <h2>Upload suppression CSV</h2>
        <p className="muted">Paste one email or domain per line (comma-separated accepted).</p>
        <form action={uploadSuppressionCsvAction}>
          <label htmlFor="csv">CSV content</label>
          <textarea id="csv" name="csv" rows={8} placeholder="alice@example.com&#10;blocked.com" />
          <button type="submit">Import list</button>
        </form>
      </section>

      <section>
        <h2>Suppression ledger</h2>
        <form className="toolbar" method="GET">
          <input type="text" name="q" placeholder="Search email or domain" defaultValue={query} />
          <select name="reason" defaultValue={reason}>
            <option value="">All reasons</option>
            <option value="unsubscribe_link">unsubscribe_link</option>
            <option value="unsubscribe_reply">unsubscribe_reply</option>
            <option value="legal_threat">legal_threat</option>
            <option value="manual">manual</option>
            <option value="bounce_hard">bounce_hard</option>
            <option value="customer_upload">customer_upload</option>
          </select>
          <button type="submit">Search</button>
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
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>{row.email || "—"}</td>
                  <td>{row.domain || "—"}</td>
                  <td>
                    <span className="card">{row.reason}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
