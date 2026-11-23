/**
 * CAN-SPAM footer + List-Unsubscribe headers for founder-sent outbound (F1-006).
 *
 * Every send from the founder's mailbox must carry, per the liability_assessor's
 * required_disclaimers[0] and the CAN-SPAM Act:
 *   1. the sender's physical postal address,
 *   2. a working, one-click unsubscribe mechanism (honored for 10 business days),
 *   3. an AI-assisted disclosure line (the drafting was machine-assisted).
 *
 * We also emit RFC 2369 `List-Unsubscribe` + RFC 8058 `List-Unsubscribe-Post`
 * headers so Gmail/Outlook render a native one-click unsubscribe control — the
 * single biggest deliverability signal for cold outbound.
 *
 * Pure string/HTML construction — no I/O, no DB. Callers pass the per-tenant
 * physical address and the signed unsubscribe URL (built from the HMAC token in
 * unsubscribe-token.ts).
 */

export interface CanSpamFooterInput {
  /** The sender's registered physical postal address (CAN-SPAM requirement). */
  physicalAddress: string;
  /** One-click unsubscribe URL (signed token embedded). */
  unsubscribeUrl: string;
  /** Recipient display name, used to soften the sign-off line. Optional. */
  recipientName?: string | null;
  /**
   * AI-assisted disclosure sentence. Defaults to the liability_assessor's
   * required_disclaimers[0] phrasing when not supplied by the caller.
   */
  aiDisclosure?: string | null;
}

export interface CanSpamFooter {
  /** Plain-text footer, prefixed with a separator, ready to append to body_text. */
  text: string;
  /** HTML footer block, ready to append to body_html. */
  html: string;
}

/** Default AI-assisted disclosure — liability_assessor.required_disclaimers[0]. */
export const DEFAULT_AI_DISCLOSURE =
  "This message was drafted with AI assistance and reviewed before sending.";

const TEXT_SEPARATOR = "\n\n--\n";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeAddress(address: string): string {
  return address.replace(/\s*\n\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Build the plain-text + HTML CAN-SPAM footer. The unsubscribe URL is rendered
 * as a literal link in both variants so it works even if the HTML part is
 * stripped by the recipient's client.
 */
export function buildCanSpamFooter(input: CanSpamFooterInput): CanSpamFooter {
  const address = normalizeAddress(input.physicalAddress || "");
  const unsubscribeUrl = input.unsubscribeUrl.trim();
  const disclosure = (input.aiDisclosure || DEFAULT_AI_DISCLOSURE).trim();

  const textLines: string[] = [disclosure];
  if (address) {
    textLines.push(address);
  }
  textLines.push(`Unsubscribe: ${unsubscribeUrl}`);
  const text = TEXT_SEPARATOR + textLines.join("\n");

  const htmlLines: string[] = [
    `<p style="margin:0 0 6px;color:#6b7280;font-size:12px;line-height:1.5;">${escapeHtml(
      disclosure,
    )}</p>`,
  ];
  if (address) {
    htmlLines.push(
      `<p style="margin:0 0 6px;color:#6b7280;font-size:12px;line-height:1.5;">${escapeHtml(
        address,
      )}</p>`,
    );
  }
  htmlLines.push(
    `<p style="margin:0;color:#6b7280;font-size:12px;line-height:1.5;">` +
      `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a>` +
      `</p>`,
  );
  const html =
    `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;">` +
    htmlLines.join("") +
    `</div>`;

  return { text, html };
}

/** Append a footer to a plain-text body (idempotent on the separator). */
export function appendTextFooter(body: string, footer: CanSpamFooter): string {
  const trimmed = (body || "").replace(/\s+$/, "");
  return `${trimmed}${footer.text}`;
}

/** Append a footer to an HTML body. */
export function appendHtmlFooter(bodyHtml: string, footer: CanSpamFooter): string {
  return `${bodyHtml || ""}${footer.html}`;
}

/**
 * RFC 2369 / RFC 8058 List-Unsubscribe headers. Supplying both the mailto: and
 * https: forms plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is what
 * unlocks the native one-click button in Gmail/Outlook.
 */
export function buildListUnsubscribeHeaders(
  unsubscribeUrl: string,
  mailtoUnsubscribe?: string | null,
): Record<string, string> {
  const targets: string[] = [`<${unsubscribeUrl.trim()}>`];
  if (mailtoUnsubscribe && mailtoUnsubscribe.trim()) {
    const addr = mailtoUnsubscribe.trim().replace(/^mailto:/i, "");
    targets.push(`<mailto:${addr}?subject=unsubscribe>`);
  }
  return {
    "List-Unsubscribe": targets.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
