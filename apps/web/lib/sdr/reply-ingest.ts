/**
 * Reply ingestion (F1-007) — the poll loop behind /api/cron/sdr-ingest-replies.
 *
 * Every 5 minutes it walks each connected founder mailbox, reads recent inbound
 * Gmail messages, MATCHES them to an outbound sdr_messages thread (by Gmail
 * threadId == sdr_messages.thread_ref), and for each new reply:
 *   1. persists an inbound sdr_messages row (direction='inbound'),
 *   2. runs the few-shot classifier (reply-classifier.ts),
 *   3. writes an sdr_replies row (message id, prospect id, body_text, received_at,
 *      classification, confidence, extracted_datetime, handled_by), and
 *   4. applies the conversation policy (conversation-policy.ts).
 *
 * Cron polling (Gmail history/list) was chosen over Pub/Sub push because Vercel
 * cron is already in the substrate and the reply SLA that matters to a founder is
 * minutes, not seconds. We call the Gmail REST API directly over fetch (no
 * googleapis dependency) using an access token refreshed from the sdr_mailboxes
 * row. De-duplication is enforced by the UNIQUE index on
 * sdr_replies(organization_id, provider_message_id).
 *
 * Server-only (fetch, pg, Buffer). Never import into a client bundle.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";
import { refreshGmailAccessToken } from "@/lib/sdr/mailbox-gmail";
import { classifyReply } from "@/lib/sdr/reply-classifier";
import { applyPolicy } from "@/lib/sdr/conversation-policy";

const GMAIL_LIST_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/** How far back each poll looks (Gmail search window) and how many to scan. */
const LOOKBACK_QUERY = "newer_than:7d";
const DEFAULT_SCAN_LIMIT = 25;

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.reply-ingest", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface IngestSummary {
  mailboxesPolled: number;
  mailboxesSkipped: number;
  messagesScanned: number;
  repliesMatched: number;
  repliesIngested: number;
  skippedDuplicate: number;
  errors: number;
  byClassification: Record<string, number>;
}

interface MailboxRow {
  id: string;
  organization_id: string;
  email: string;
  domain: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | Date | null;
}

interface ThreadContextRow {
  thread_ref: string;
  prospect_id: string | null;
  campaign_id: string | null;
  sequence_id: string | null;
  outbound_subject: string | null;
  outbound_body: string | null;
  email: string | null;
  company_domain: string | null;
  full_name: string | null;
  company_name: string | null;
  vertical: string | null;
  value_prop: string | null;
}

interface GmailListItem {
  id: string;
  threadId: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailPart[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail REST helpers (direct fetch — no googleapis dependency)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveAccessToken(mailbox: MailboxRow): Promise<string | null> {
  const expiresAt = mailbox.token_expires_at
    ? new Date(mailbox.token_expires_at).getTime()
    : 0;
  const stillValid = mailbox.access_token && expiresAt > Date.now() + 60_000;
  if (stillValid) return mailbox.access_token;

  const refreshed = await refreshGmailAccessToken(mailbox.refresh_token);
  if (refreshed) {
    // Persist the refreshed token so subsequent polls reuse it.
    try {
      const db = buildDb();
      await db.execute(
        `UPDATE sdr_mailboxes
            SET access_token = $3, token_expires_at = $4, updated_at = NOW()
          WHERE organization_id = $1 AND id = $2`,
        mailbox.organization_id,
        mailbox.id,
        refreshed.accessToken,
        new Date(refreshed.expiresAt).toISOString(),
      );
    } catch (err) {
      log("warn", "token_persist_failed", { mailboxId: mailbox.id, error: String((err as Error).message) });
    }
    return refreshed.accessToken;
  }
  // Last resort: a non-expired-in-row token even if we couldn't refresh.
  return mailbox.access_token;
}

async function gmailList(accessToken: string, limit: number): Promise<GmailListItem[]> {
  const qs = new URLSearchParams({ q: LOOKBACK_QUERY, maxResults: String(limit) });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${GMAIL_LIST_URL}?${qs.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      log("warn", "gmail_list_non_ok", { status: res.status });
      return [];
    }
    const data = (await res.json()) as { messages?: GmailListItem[] };
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (err) {
    log("warn", "gmail_list_failed", { error: String((err as Error).message) });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function gmailGet(accessToken: string, id: string): Promise<GmailMessage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${GMAIL_LIST_URL}/${encodeURIComponent(id)}?format=full`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as GmailMessage;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** Walk the MIME tree and return the first text/plain body (falls back to html, stripped). */
function extractBody(message: GmailMessage): string {
  const payload = message.payload;
  if (!payload) return "";

  const collect = (part: GmailPart, wantPlain: boolean): string => {
    const mime = (part.mimeType ?? "").toLowerCase();
    if (part.parts && part.parts.length) {
      for (const child of part.parts) {
        const found = collect(child, wantPlain);
        if (found) return found;
      }
      return "";
    }
    const target = wantPlain ? "text/plain" : "text/html";
    if (mime === target && part.body?.data) return decodeBase64Url(part.body.data);
    return "";
  };

  // Top-level single-part message.
  if (payload.body?.data && (!payload.parts || payload.parts.length === 0)) {
    const raw = decodeBase64Url(payload.body.data);
    return (payload.mimeType ?? "").toLowerCase() === "text/html" ? stripHtml(raw) : raw;
  }

  const root: GmailPart = { mimeType: payload.mimeType, body: payload.body, parts: payload.parts };
  const plain = collect(root, true);
  if (plain) return plain;
  const html = collect(root, false);
  return html ? stripHtml(html) : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|br|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Quoted-reply trimmer: drop everything from the first "On ... wrote:" quote header. */
function stripQuotedTail(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .+ wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+<.+@.+>/i.test(line) && out.length > 0) break;
    out.push(line);
  }
  // If everything was quoted, keep the original rather than emitting nothing.
  const trimmed = out.join("\n").trim();
  return trimmed.length > 0 ? trimmed : body.trim();
}

function parseFromEmail(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const angle = fromHeader.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : fromHeader).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadMailboxes(organizationId?: string): Promise<MailboxRow[]> {
  const db = buildDb();
  if (organizationId) {
    return db.query<MailboxRow>(
      `SELECT id, organization_id, email, domain, access_token, refresh_token, token_expires_at
         FROM sdr_mailboxes
        WHERE organization_id = $1 AND status = 'connected'
        ORDER BY created_at ASC`,
      organizationId,
    );
  }
  return db.query<MailboxRow>(
    `SELECT id, organization_id, email, domain, access_token, refresh_token, token_expires_at
       FROM sdr_mailboxes
      WHERE status = 'connected'
      ORDER BY created_at ASC`,
  );
}

async function loadThreadContext(organizationId: string): Promise<Map<string, ThreadContextRow>> {
  const db = buildDb();
  const rows = await db.query<ThreadContextRow>(
    `SELECT DISTINCT ON (m.thread_ref)
            m.thread_ref,
            m.prospect_id,
            m.campaign_id,
            m.sequence_id,
            m.subject AS outbound_subject,
            m.body_text AS outbound_body,
            p.email,
            p.company_domain,
            p.full_name,
            p.company_name,
            c.vertical,
            COALESCE(c.value_prop, c.offer) AS value_prop
       FROM sdr_messages m
       LEFT JOIN sdr_prospects p ON p.id = m.prospect_id
       LEFT JOIN sdr_campaigns c ON c.id = m.campaign_id
      WHERE m.organization_id = $1
        AND m.direction = 'outbound'
        AND m.thread_ref IS NOT NULL
      ORDER BY m.thread_ref, m.touch_index DESC, m.created_at DESC`,
    organizationId,
  );
  const map = new Map<string, ThreadContextRow>();
  for (const row of rows) map.set(row.thread_ref, row);
  return map;
}

async function alreadyIngested(organizationId: string, providerMessageId: string): Promise<boolean> {
  const db = buildDb();
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM sdr_replies
      WHERE organization_id = $1 AND provider_message_id = $2
      LIMIT 1`,
    organizationId,
    providerMessageId,
  );
  return rows.length > 0;
}

async function insertInboundMessage(params: {
  organizationId: string;
  campaignId: string | null;
  prospectId: string | null;
  sequenceId: string | null;
  providerMessageId: string;
  subject: string | null;
  bodyText: string;
  receivedAtIso: string;
  threadRef: string;
  rfc822MessageId: string | null;
}): Promise<string> {
  const db = buildDb();
  const id = randomUUID();
  await db.execute(
    `INSERT INTO sdr_messages
       (id, organization_id, campaign_id, prospect_id, sequence_id, provider,
        provider_message_id, direction, subject, body_text, sent_at, status,
        thread_ref, rfc822_message_id)
     VALUES ($1, $2, $3, $4, $5, 'gmail',
        $6, 'inbound', $7, $8, $9, 'received',
        $10, $11)`,
    id,
    params.organizationId,
    params.campaignId,
    params.prospectId,
    params.sequenceId,
    params.providerMessageId,
    params.subject,
    params.bodyText,
    params.receivedAtIso,
    params.threadRef,
    params.rfc822MessageId,
  );
  return id;
}

async function insertReply(params: {
  organizationId: string;
  campaignId: string | null;
  prospectId: string | null;
  sequenceId: string | null;
  mailboxId: string;
  threadRef: string;
  providerMessageId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string;
  receivedAtIso: string;
  inboundMessageId: string;
  classification: string;
  confidence: number;
  classifierSource: string;
  reasoning: string;
  extractedDatetime: string | null;
  handledBy: string;
}): Promise<string | null> {
  const db = buildDb();
  const id = randomUUID();
  // ON CONFLICT guards the race where two polls overlap on the same message.
  const rows = await db.query<{ id: string }>(
    `INSERT INTO sdr_replies
       (id, organization_id, campaign_id, prospect_id, sequence_id, message_id,
        mailbox_id, thread_ref, provider, provider_message_id, from_email, subject,
        body_text, received_at, classification, confidence, classifier_source,
        reasoning, extracted_datetime, handled_by)
     VALUES ($1, $2, $3, $4, $5, $6,
        $7, $8, 'gmail', $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, $19)
     ON CONFLICT (organization_id, provider_message_id) DO NOTHING
     RETURNING id`,
    id,
    params.organizationId,
    params.campaignId,
    params.prospectId,
    params.sequenceId,
    params.inboundMessageId,
    params.mailboxId,
    params.threadRef,
    params.providerMessageId,
    params.fromEmail,
    params.subject,
    params.bodyText,
    params.receivedAtIso,
    params.classification,
    params.confidence,
    params.classifierSource,
    params.reasoning,
    params.extractedDatetime,
    params.handledBy,
  );
  return rows[0]?.id ?? null;
}

async function markPolled(organizationId: string, mailboxId: string, historyId: string | null): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_mailboxes
        SET last_polled_at = NOW(), last_history_id = COALESCE($3, last_history_id), updated_at = NOW()
      WHERE organization_id = $1 AND id = $2`,
    organizationId,
    mailboxId,
    historyId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll every connected mailbox (or one org's mailboxes) for new inbound replies,
 * classify them, persist sdr_replies, and run the conversation policy. Returns a
 * summary. Per-message failures are logged and counted but never abort the run.
 */
export async function ingestReplies(params: {
  nowMs: number;
  organizationId?: string;
  limit?: number;
}): Promise<IngestSummary> {
  const scanLimit = params.limit && params.limit > 0 ? params.limit : DEFAULT_SCAN_LIMIT;
  const summary: IngestSummary = {
    mailboxesPolled: 0,
    mailboxesSkipped: 0,
    messagesScanned: 0,
    repliesMatched: 0,
    repliesIngested: 0,
    skippedDuplicate: 0,
    errors: 0,
    byClassification: {},
  };

  const mailboxes = await loadMailboxes(params.organizationId);
  // Cache thread context per org so multiple mailboxes in one org share it.
  const threadCache = new Map<string, Map<string, ThreadContextRow>>();

  for (const mailbox of mailboxes) {
    const accessToken = await resolveAccessToken(mailbox);
    if (!accessToken) {
      summary.mailboxesSkipped += 1;
      log("info", "mailbox_no_credentials", { mailboxId: mailbox.id });
      continue;
    }

    let threads = threadCache.get(mailbox.organization_id);
    if (!threads) {
      threads = await loadThreadContext(mailbox.organization_id);
      threadCache.set(mailbox.organization_id, threads);
    }

    summary.mailboxesPolled += 1;
    const listed = await gmailList(accessToken, scanLimit);
    let latestHistoryId: string | null = null;

    for (const item of listed) {
      summary.messagesScanned += 1;
      const ctx = threads.get(item.threadId);
      if (!ctx) continue; // not one of our outbound threads
      summary.repliesMatched += 1;

      try {
        if (await alreadyIngested(mailbox.organization_id, item.id)) {
          summary.skippedDuplicate += 1;
          continue;
        }

        const message = await gmailGet(accessToken, item.id);
        if (!message) {
          summary.errors += 1;
          continue;
        }
        if (message.internalDate && (!latestHistoryId || message.internalDate > latestHistoryId)) {
          latestHistoryId = message.internalDate;
        }

        const headers = message.payload?.headers;
        const fromEmail = parseFromEmail(headerValue(headers, "From"));
        // Skip our own outbound copies that also live in the thread.
        if (fromEmail && fromEmail === mailbox.email.trim().toLowerCase()) continue;

        const subject = headerValue(headers, "Subject");
        const rfc822MessageId = headerValue(headers, "Message-ID") ?? headerValue(headers, "Message-Id");
        const receivedAtIso = message.internalDate
          ? new Date(Number(message.internalDate)).toISOString()
          : new Date(params.nowMs).toISOString();
        const rawBody = extractBody(message);
        const bodyText = stripQuotedTail(rawBody).slice(0, 20_000);

        // 1. Persist the inbound message row.
        const inboundMessageId = await insertInboundMessage({
          organizationId: mailbox.organization_id,
          campaignId: ctx.campaign_id,
          prospectId: ctx.prospect_id,
          sequenceId: ctx.sequence_id,
          providerMessageId: item.id,
          subject,
          bodyText,
          receivedAtIso,
          threadRef: item.threadId,
          rfc822MessageId,
        });

        // 2. Classify.
        const classification = await classifyReply({
          bodyText,
          context: {
            prospectName: ctx.full_name,
            company: ctx.company_name,
            outboundSubject: ctx.outbound_subject,
            outboundBody: ctx.outbound_body,
            receivedAtIso,
          },
        });

        // Provisional handled_by; conversation-policy finalizes it.
        const provisionalHandledBy =
          classification.classification === "legal_threat"
            ? "operator"
            : classification.classification === "unclear" ||
                classification.confidence < 0.85
              ? "customer"
              : "agent";

        // 3. Write the reply row (idempotent).
        const replyId = await insertReply({
          organizationId: mailbox.organization_id,
          campaignId: ctx.campaign_id,
          prospectId: ctx.prospect_id,
          sequenceId: ctx.sequence_id,
          mailboxId: mailbox.id,
          threadRef: item.threadId,
          providerMessageId: item.id,
          fromEmail,
          subject,
          bodyText,
          receivedAtIso,
          inboundMessageId,
          classification: classification.classification,
          confidence: classification.confidence,
          classifierSource: classification.source,
          reasoning: classification.reasoning,
          extractedDatetime: classification.extractedDatetime,
          handledBy: provisionalHandledBy,
        });

        if (!replyId) {
          // Lost the ON CONFLICT race — another poll already handled it.
          summary.skippedDuplicate += 1;
          continue;
        }

        summary.repliesIngested += 1;
        summary.byClassification[classification.classification] =
          (summary.byClassification[classification.classification] ?? 0) + 1;

        // 4. Apply the conversation policy.
        await applyPolicy({
          organizationId: mailbox.organization_id,
          replyId,
          prospectId: ctx.prospect_id,
          campaignId: ctx.campaign_id,
          sequenceId: ctx.sequence_id,
          mailboxId: mailbox.id,
          prospectEmail: ctx.email ?? fromEmail,
          prospectDomain: ctx.company_domain,
          prospectName: ctx.full_name,
          company: ctx.company_name,
          threadRef: item.threadId,
          inboundMessageId,
          classification: classification.classification,
          confidence: classification.confidence,
          extractedDatetime: classification.extractedDatetime,
          vertical: ctx.vertical,
          valueProp: ctx.value_prop,
          priorOutboundSubject: ctx.outbound_subject,
          priorOutboundBody: ctx.outbound_body,
          replyBody: bodyText,
          nowMs: params.nowMs,
        });
      } catch (err) {
        summary.errors += 1;
        log("error", "reply_ingest_failed", {
          mailboxId: mailbox.id,
          providerMessageId: item.id,
          error: String((err as Error).message),
        });
      }
    }

    await markPolled(mailbox.organization_id, mailbox.id, latestHistoryId).catch((err) =>
      log("warn", "mark_polled_failed", { mailboxId: mailbox.id, error: String((err as Error).message) }),
    );
  }

  log("info", "ingest_complete", { ...summary, byClassification: JSON.stringify(summary.byClassification) });
  return summary;
}
