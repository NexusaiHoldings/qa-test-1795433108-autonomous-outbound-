/**
 * Gmail send client (F1-006).
 *
 * The 'send' verb executes from the founder's OWN Gmail so the customer — not
 * Nexus — is the CAN-SPAM sender and replies land in the inbox they already
 * live in. We talk to the Gmail REST API directly over fetch (users.messages.send
 * + users.messages.get for threading) rather than pulling in the heavyweight
 * googleapis package; the only input we need is an OAuth access token carrying
 * the gmail.send scope. Obtaining that token is the @nexus/profile-and-account
 * connected-accounts lego gap flagged in blockers — until it closes, the token
 * is held on the sdr_mailboxes row.
 *
 * Server-only (uses Buffer). Never import into a client component.
 */

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_MESSAGE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface RawMessageInput {
  from: string;
  fromName?: string | null;
  to: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  /** Extra headers (List-Unsubscribe, Reply-To, …). */
  headers?: Record<string, string>;
  /** RFC822 Message-ID of the touch-1 message we are replying to (touches 2-3). */
  inReplyTo?: string | null;
  /** References chain for threading (space-separated Message-IDs). */
  references?: string | null;
}

export interface GmailSendResult {
  ok: boolean;
  providerMessageId: string | null;
  threadId: string | null;
  rfc822MessageId: string | null;
  status: number;
  error?: string;
  payload: unknown;
}

function encodeHeaderWord(value: string): string {
  // RFC 2047 encode only when non-ASCII is present; keep plain ASCII readable.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress(email: string, name?: string | null): string {
  if (!name) return email;
  return `${encodeHeaderWord(name)} <${email}>`;
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/**
 * Generate a deterministic-ish RFC822 Message-ID for the send. Gmail assigns its
 * own, but supplying one lets us thread touches 2-3 before we round-trip to read
 * Gmail's assigned header.
 */
export function generateMessageId(domain: string): string {
  const rand = Buffer.from(`${process.pid}:${process.hrtime.bigint().toString()}`).toString("hex").slice(0, 24);
  const host = domain && domain.includes(".") ? domain : "mail.gmail.com";
  return `<sdr-${rand}@${host}>`;
}

/**
 * Build a MIME message and base64url-encode it for the Gmail raw send endpoint.
 * Emits multipart/alternative when an HTML body is supplied, else text/plain.
 */
export function buildRawMessage(input: RawMessageInput): { raw: string; messageId: string } {
  const domain = input.from.includes("@") ? input.from.split("@")[1] : "mail.gmail.com";
  const messageId = generateMessageId(domain);

  const headers: string[] = [
    `From: ${formatAddress(input.from, input.fromName)}`,
    `To: ${formatAddress(input.to, input.toName)}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];

  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
    headers.push(`References: ${input.references || input.inReplyTo}`);
  }

  for (const [key, value] of Object.entries(input.headers || {})) {
    if (value != null && String(value).length > 0) {
      headers.push(`${key}: ${String(value).replace(/[\r\n]+/g, " ")}`);
    }
  }

  let body: string;
  if (input.bodyHtml && input.bodyHtml.trim()) {
    const boundary = `=_sdr_${Buffer.from(messageId).toString("hex").slice(0, 16)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      `${input.bodyText}\r\n\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      `${input.bodyHtml}\r\n\r\n` +
      `--${boundary}--`;
  } else {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    headers.push(`Content-Transfer-Encoding: 8bit`);
    body = input.bodyText;
  }

  const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return { raw: toBase64Url(mime), messageId };
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Send a raw MIME message through the founder's Gmail. threadId, when supplied,
 * keeps touches 2-3 in the same conversation as touch 1.
 */
export async function sendGmailMessage(params: {
  accessToken: string;
  raw: string;
  threadId?: string | null;
}): Promise<GmailSendResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        params.threadId ? { raw: params.raw, threadId: params.threadId } : { raw: params.raw },
      ),
    });
    const payload = await parseJson(res);
    if (!res.ok) {
      const error =
        (payload as { error?: { message?: string } })?.error?.message || `gmail_http_${res.status}`;
      return {
        ok: false,
        providerMessageId: null,
        threadId: null,
        rfc822MessageId: null,
        status: res.status,
        error,
        payload,
      };
    }
    const data = payload as { id?: string; threadId?: string };
    return {
      ok: true,
      providerMessageId: data.id ?? null,
      threadId: data.threadId ?? null,
      rfc822MessageId: null,
      status: res.status,
      payload,
    };
  } catch (err) {
    return {
      ok: false,
      providerMessageId: null,
      threadId: null,
      rfc822MessageId: null,
      status: 0,
      error: String((err as Error).message),
      payload: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the RFC822 Message-ID + threadId Gmail assigned to a sent message, so
 * subsequent touches can thread as replies (In-Reply-To / References).
 */
export async function fetchGmailMessageMeta(params: {
  accessToken: string;
  providerMessageId: string;
}): Promise<{ threadId: string | null; rfc822MessageId: string | null }> {
  const url = `${GMAIL_MESSAGE_URL}/${encodeURIComponent(
    params.providerMessageId,
  )}?format=metadata&metadataHeaders=Message-ID`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${params.accessToken}` },
    });
    if (!res.ok) return { threadId: null, rfc822MessageId: null };
    const data = (await res.json()) as {
      threadId?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const header = (data.payload?.headers || []).find((h) => h.name.toLowerCase() === "message-id");
    return { threadId: data.threadId ?? null, rfc822MessageId: header?.value ?? null };
  } catch {
    return { threadId: null, rfc822MessageId: null };
  }
}

/**
 * Exchange a stored refresh token for a fresh access token. Returns null when no
 * refresh token / client credentials are configured (the OAuth lego gap), which
 * the dispatcher treats as "cannot send right now" rather than an error.
 */
export async function refreshGmailAccessToken(
  refreshToken: string | null,
): Promise<{ accessToken: string; expiresAt: number } | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) return null;

  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Build the Google OAuth consent URL for connecting a sending mailbox. The
 * gmail.send scope is the extended scope the connected-accounts lego does not
 * yet request (blocker); this surfaces it directly from the domain until then.
 */
export function buildGmailConsentUrl(params: {
  redirectUri: string;
  state: string;
  loginHint?: string | null;
}): string | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;
  const scopes = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "openid",
    "email",
  ].join(" ");
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: scopes,
    access_type: "offline",
    prompt: "consent",
    state: params.state,
  });
  if (params.loginHint) qs.set("login_hint", params.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
}
