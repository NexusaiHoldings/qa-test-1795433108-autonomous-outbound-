/**
 * Outlook / Microsoft 365 send client (F1-006, should-have).
 *
 * Mirror of mailbox-gmail.ts for founders who live in Outlook. Uses the Microsoft
 * Graph REST API over fetch (createMessage → send, so we can set internet message
 * headers for List-Unsubscribe and thread touches 2-3 as replies). Needs an OAuth
 * access token with Mail.Send; acquiring it is the same connected-accounts lego
 * gap flagged for Gmail.
 *
 * Server-only. Never import into a client component.
 */

const GRAPH_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/messages";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export interface OutlookSendInput {
  accessToken: string;
  to: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  headers?: Record<string, string>;
  /** Graph message id of touch 1 — touches 2-3 reply to it to keep the thread. */
  replyToMessageId?: string | null;
}

export interface OutlookSendResult {
  ok: boolean;
  providerMessageId: string | null;
  conversationId: string | null;
  rfc822MessageId: string | null;
  status: number;
  error?: string;
  payload: unknown;
}

/** Graph forbids the reserved x-prefix-free custom headers; only internet headers. */
function toInternetHeaders(headers: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  if (!headers) return [];
  return Object.entries(headers)
    .filter(([, value]) => value != null && String(value).length > 0)
    .map(([name, value]) => ({ name, value: String(value).replace(/[\r\n]+/g, " ") }));
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Create a draft, attach headers, then send it. The draft/send split (vs the
 * simpler /sendMail) is what lets us set List-Unsubscribe internet headers and
 * read back the conversationId + Message-ID for threading.
 */
export async function sendOutlookMessage(input: OutlookSendInput): Promise<OutlookSendResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const createUrl = input.replyToMessageId
      ? `${GRAPH_MESSAGES_URL}/${encodeURIComponent(input.replyToMessageId)}/createReply`
      : GRAPH_MESSAGES_URL;

    const contentType = input.bodyHtml && input.bodyHtml.trim() ? "HTML" : "Text";
    const content = contentType === "HTML" ? input.bodyHtml ?? "" : input.bodyText;

    const draftBody = input.replyToMessageId
      ? {
          message: {
            body: { contentType, content },
            internetMessageHeaders: toInternetHeaders(input.headers),
          },
          comment: "",
        }
      : {
          subject: input.subject,
          body: { contentType, content },
          toRecipients: [
            { emailAddress: { address: input.to, name: input.toName || undefined } },
          ],
          internetMessageHeaders: toInternetHeaders(input.headers),
        };

    const createRes = await fetch(createUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(draftBody),
    });
    const draft = await parseJson(createRes);
    if (!createRes.ok) {
      const error =
        (draft as { error?: { message?: string } })?.error?.message || `graph_http_${createRes.status}`;
      return {
        ok: false,
        providerMessageId: null,
        conversationId: null,
        rfc822MessageId: null,
        status: createRes.status,
        error,
        payload: draft,
      };
    }

    const draftData = draft as {
      id?: string;
      conversationId?: string;
      internetMessageId?: string;
    };
    if (!draftData.id) {
      return {
        ok: false,
        providerMessageId: null,
        conversationId: null,
        rfc822MessageId: null,
        status: createRes.status,
        error: "graph_draft_missing_id",
        payload: draft,
      };
    }

    const sendRes = await fetch(`${GRAPH_MESSAGES_URL}/${encodeURIComponent(draftData.id)}/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
    if (!sendRes.ok) {
      const sendErr = await parseJson(sendRes);
      const error =
        (sendErr as { error?: { message?: string } })?.error?.message || `graph_send_http_${sendRes.status}`;
      return {
        ok: false,
        providerMessageId: draftData.id,
        conversationId: draftData.conversationId ?? null,
        rfc822MessageId: draftData.internetMessageId ?? null,
        status: sendRes.status,
        error,
        payload: sendErr,
      };
    }

    return {
      ok: true,
      providerMessageId: draftData.id,
      conversationId: draftData.conversationId ?? null,
      rfc822MessageId: draftData.internetMessageId ?? null,
      status: sendRes.status,
      payload: draft,
    };
  } catch (err) {
    return {
      ok: false,
      providerMessageId: null,
      conversationId: null,
      rfc822MessageId: null,
      status: 0,
      error: String((err as Error).message),
      payload: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Exchange a stored refresh token for a fresh Graph access token. */
export async function refreshOutlookAccessToken(
  refreshToken: string | null,
): Promise<{ accessToken: string; expiresAt: number } | null> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) return null;
  try {
    const res = await fetch(MS_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "https://graph.microsoft.com/Mail.Send offline_access",
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

/** Build the Microsoft OAuth consent URL for connecting an Outlook mailbox. */
export function buildOutlookConsentUrl(params: {
  redirectUri: string;
  state: string;
  loginHint?: string | null;
}): string | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) return null;
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: "openid email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read",
    state: params.state,
  });
  if (params.loginHint) qs.set("login_hint", params.loginHint);
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${qs.toString()}`;
}
