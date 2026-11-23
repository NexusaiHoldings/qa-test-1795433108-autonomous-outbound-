/**
 * SPF / DKIM / DMARC validation for a sending domain (F1-006).
 *
 * Run on mailbox connect (and re-run from the /mailbox fix-it drawer). A domain
 * that fails any of the three authentication checks tanks deliverability, so the
 * dispatcher refuses to ramp warmup past stage 0 until all three pass.
 *
 * Uses Node's built-in DNS resolver over TXT records — no third-party package,
 * no bundling concerns. All lookups are wrapped so a NXDOMAIN / timeout degrades
 * to "not ok" rather than throwing. node:dns is a server-only builtin; this
 * module must never be imported into a client component.
 */

import { promises as dnsPromises, setServers } from "node:dns";

export interface DnsCheckDetail {
  ok: boolean;
  record: string | null;
  note: string;
}

export interface DomainAuthResult {
  domain: string;
  spf: DnsCheckDetail;
  dkim: DnsCheckDetail;
  dmarc: DnsCheckDetail;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
  allOk: boolean;
  checkedAt: string;
}

/** Common DKIM selectors to probe — Google uses `google`, M365 `selector1/2`. */
const DKIM_SELECTORS = ["google", "selector1", "selector2", "s1", "s2", "default", "k1", "dkim"];

let serversConfigured = false;

/**
 * Point the resolver at public resolvers when the serverless runtime has no
 * resolv.conf (Vercel functions sometimes ship none → ENOTFOUND on every
 * lookup). Idempotent; swallows failures (older Node builds restrict setServers).
 */
function ensureResolvers(): void {
  if (serversConfigured) return;
  serversConfigured = true;
  const configured = (process.env.SDR_DNS_RESOLVERS || "").trim();
  const servers = configured
    ? configured.split(",").map((s) => s.trim()).filter(Boolean)
    : ["1.1.1.1", "8.8.8.8"];
  try {
    setServers(servers);
  } catch {
    // Non-fatal — fall back to whatever the runtime resolver is.
  }
}

export function domainFromEmail(email: string): string {
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : email.trim().toLowerCase();
}

async function resolveTxt(name: string): Promise<string[]> {
  ensureResolvers();
  try {
    const records = await dnsPromises.resolveTxt(name);
    // Each record is a string[] of chunks that must be joined (TXT 255-char split).
    return records.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

export async function checkSpf(domain: string): Promise<DnsCheckDetail> {
  const txts = await resolveTxt(domain);
  const spf = txts.find((t) => /v=spf1/i.test(t));
  if (!spf) {
    return { ok: false, record: null, note: "No v=spf1 TXT record found on the domain." };
  }
  const hardFail = /[~-]all\b/i.test(spf);
  return {
    ok: true,
    record: spf,
    note: hardFail
      ? "SPF present with a restrictive all mechanism."
      : "SPF present. Consider tightening to ~all or -all.",
  };
}

export async function checkDmarc(domain: string): Promise<DnsCheckDetail> {
  const txts = await resolveTxt(`_dmarc.${domain}`);
  const dmarc = txts.find((t) => /v=DMARC1/i.test(t));
  if (!dmarc) {
    return {
      ok: false,
      record: null,
      note: "No v=DMARC1 record at _dmarc. Publish a DMARC policy.",
    };
  }
  const policyMatch = dmarc.match(/\bp=([a-z]+)/i);
  const policy = policyMatch ? policyMatch[1].toLowerCase() : "none";
  return {
    ok: true,
    record: dmarc,
    note: policy === "none" ? "DMARC published at p=none (monitor mode)." : `DMARC policy p=${policy}.`,
  };
}

/**
 * Probe a handful of common DKIM selectors. A domain passes as long as at least
 * one selector resolves to a DKIM key (v=DKIM1 or a k=/p= pair).
 */
export async function checkDkim(domain: string, selectors: string[] = DKIM_SELECTORS): Promise<DnsCheckDetail> {
  for (const selector of selectors) {
    const txts = await resolveTxt(`${selector}._domainkey.${domain}`);
    const dkim = txts.find((t) => /v=DKIM1/i.test(t) || (/k=/i.test(t) && /p=/i.test(t)));
    if (dkim) {
      return {
        ok: true,
        record: dkim,
        note: `DKIM key found on selector "${selector}".`,
      };
    }
  }
  return {
    ok: false,
    record: null,
    note: "No DKIM key found on common selectors (google, selector1/2). Enable DKIM signing.",
  };
}

/**
 * True when the domain publishes at least one MX record. Used as the fallback
 * deliverability signal when no external verification API is configured.
 */
export async function hasMxRecord(domain: string): Promise<boolean> {
  ensureResolvers();
  try {
    const mx = await dnsPromises.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

/** Run all three checks concurrently and summarize. */
export async function checkDomainAuth(domainOrEmail: string): Promise<DomainAuthResult> {
  const domain = domainOrEmail.includes("@") ? domainFromEmail(domainOrEmail) : domainOrEmail.trim().toLowerCase();

  const [spf, dkim, dmarc] = await Promise.all([
    checkSpf(domain),
    checkDkim(domain),
    checkDmarc(domain),
  ]);

  return {
    domain,
    spf,
    dkim,
    dmarc,
    spfOk: spf.ok,
    dkimOk: dkim.ok,
    dmarcOk: dmarc.ok,
    allOk: spf.ok && dkim.ok && dmarc.ok,
    checkedAt: new Date().toISOString(),
  };
}
