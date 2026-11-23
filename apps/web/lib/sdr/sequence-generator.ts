/**
 * Grounded sequence generator (F1-005).
 *
 * The CEO briefing's "GPT-powered 3-email sequence generator", realized on the
 * substrate: for each newly SOURCED prospect that carries at least one trigger
 * signal, draft a 3-touch outbound cadence (intro / value / break-up) via the
 * Nexus gateway (Claude Sonnet class, structured output), grounded in the
 * prospect's sdr_prospect_signals rows and the campaign value_prop.
 *
 * Grounding gate (grounding-check.ts) forces every factual claim to cite a signal
 * id; an uncited claim triggers regeneration, then — if still ungrounded — the
 * sequence is dropped rather than sent (the mitigation for
 * feasibility_analysis.key_technical_risks[2]).
 *
 * The gateway is optional: when NEXUS_GATEWAY_URL is unset or the call fails, a
 * deterministic template drafter composes grounded, cited copy from the vertical
 * prompt library + the signals — so the cron always produces real output.
 *
 * Owns sdr_sequences, sdr_messages (as sequence touches), and the segment-approval
 * read/write surface the /approvals page drives. Everything tenant-scoped by
 * organization_id; raw parameterized SQL via the substrate pg pool.
 */

import { randomUUID } from "crypto";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import { handleMissingAcknowledgments } from "@nexus/legal-and-compliance";
import { LEGAL_PROMPTS } from "@/lib/sdr/prompts/legal";
import { ACCOUNTING_PROMPTS } from "@/lib/sdr/prompts/accounting";
import { IT_CONSULTING_PROMPTS } from "@/lib/sdr/prompts/it-consulting";
import {
  checkGrounding,
  sanitizeCitations,
  type Citation,
  type SignalRef,
} from "@/lib/sdr/grounding-check";

// ─────────────────────────────────────────────────────────────────────────────
// Public types consumed by the vertical prompt libraries
// ─────────────────────────────────────────────────────────────────────────────

export interface TouchGuidance {
  /** 0-based position in the 3-touch cadence. */
  index: number;
  label: string;
  /** Days after touch 0 that this touch sends. */
  dayOffset: number;
  goal: string;
  /** Instructions handed to the gateway LLM for this touch. */
  guidance: string;
  /**
   * Deterministic fallback body with {{placeholders}}. Used when the gateway is
   * unavailable; placeholders are filled from the strongest signal + value prop so
   * the result is already grounded.
   */
  fallbackTemplate: string;
}

export interface VerticalPromptLibrary {
  key: string;
  label: string;
  audience: string;
  systemPrompt: string;
  valueProps: string[];
  painPoints: string[];
  proofPoints: string[];
  subjectPatterns: string[];
  touches: TouchGuidance[];
  complianceNotes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Enums + constants
// ─────────────────────────────────────────────────────────────────────────────

export const MESSAGE_STATUSES = [
  "draft",
  "approved",
  "queued",
  "sent",
  "bounced",
  "cancelled",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const SEQUENCE_STATUSES = [
  "pending_approval",
  "active",
  "completed",
  "cancelled",
] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

/** Regeneration attempts before a sequence is dropped for failing grounding. */
export const MAX_REGENERATIONS = 2;

/** Approve this many sequences in a segment to unlock autonomous sending. */
export const SEGMENT_UNLOCK_THRESHOLD = 5;

/** Fixed send cadence (days after touch 0) — intro / value / break-up. */
export const TOUCH_DAY_OFFSETS: readonly number[] = [0, 3, 7];

const TOUCH_COUNT = 3;

const LIBRARIES: Record<string, VerticalPromptLibrary> = {
  legal: LEGAL_PROMPTS,
  accounting: ACCOUNTING_PROMPTS,
  "it-consulting": IT_CONSULTING_PROMPTS,
  "it_consulting": IT_CONSULTING_PROMPTS,
  it: IT_CONSULTING_PROMPTS,
};

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, source: "sdr.sequence-generator", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Resolve the vertical prompt library for a campaign vertical (defaults to legal). */
export function resolveLibrary(vertical: string | null | undefined): VerticalPromptLibrary {
  const key = (vertical ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return LIBRARIES[key] ?? LEGAL_PROMPTS;
}

/** Bucket a job title into a coarse seniority band for segment keying. */
export function titleBand(title: string | null | undefined): string {
  const t = (title ?? "").toLowerCase();
  if (!t) return "unknown";
  if (/\b(ceo|cfo|coo|cto|cio|chief|founder|owner|president|managing partner)\b/.test(t)) {
    return "exec";
  }
  if (/\b(partner|principal|gc|general counsel|vp|vice president|head)\b/.test(t)) {
    return "partner";
  }
  if (/\b(director|controller|practice lead|lead)\b/.test(t)) return "director";
  if (/\b(manager|supervisor)\b/.test(t)) return "manager";
  return "ic";
}

/** segment_key = vertical + title-band (the unit the founder approves once). */
export function segmentKey(vertical: string | null | undefined, title: string | null | undefined): string {
  const lib = resolveLibrary(vertical);
  return `${lib.key}:${titleBand(title)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft shape (gateway + fallback share it)
// ─────────────────────────────────────────────────────────────────────────────

interface DraftTouch {
  subject: string;
  body: string;
  citations: Citation[];
}

interface SequenceDraft {
  touches: DraftTouch[];
  source: "gateway" | "fallback";
}

interface ProspectContext {
  firstName: string;
  fullName: string;
  company: string;
  valueProp: string;
  senderName: string;
  signals: SignalRef[];
}

function firstSentenceOf(headline: string): string {
  const h = headline.trim().replace(/\s+/g, " ");
  if (!h) return "";
  return /[.!?]$/.test(h) ? h : `${h}.`;
}

function shortenHeadline(headline: string): string {
  const h = headline.trim().replace(/\s+/g, " ");
  return h.length > 70 ? `${h.slice(0, 67)}…` : h;
}

/** Fill {{placeholder}} tokens in a template with the provided values. */
function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
}

/**
 * Deterministic, always-grounded drafter. Builds each touch from its
 * fallbackTemplate using the strongest signal (which is cited) plus the campaign
 * value prop and vertical pain/proof points. Used when the gateway is unavailable.
 */
function fallbackDraft(lib: VerticalPromptLibrary, ctx: ProspectContext): SequenceDraft {
  const topSignal = ctx.signals[0] ?? null;
  const signalSentence = topSignal
    ? `Saw that ${firstSentenceOf(topSignal.headline).charAt(0).toLowerCase()}${firstSentenceOf(topSignal.headline).slice(1)}`
    : "";
  const signalShort = topSignal ? shortenHeadline(topSignal.headline) : "your recent growth";

  const touches: DraftTouch[] = lib.touches.slice(0, TOUCH_COUNT).map((touch, i) => {
    const valueProp = ctx.valueProp || lib.valueProps[i % lib.valueProps.length];
    const body = fillTemplate(touch.fallbackTemplate, {
      firstName: ctx.firstName,
      company: ctx.company,
      valueProp,
      proofPoint: lib.proofPoints[i % lib.proofPoints.length],
      painPoint: lib.painPoints[i % lib.painPoints.length],
      signalSentence,
      signalShort,
      senderName: ctx.senderName,
    });
    const subject = fillTemplate(lib.subjectPatterns[i % lib.subjectPatterns.length], {
      firstName: ctx.firstName,
      company: ctx.company,
      signalShort,
    });

    // Cite the signal in every touch whose body actually restates it (touch 0 via
    // the full "Saw that…" sentence, the value follow-up via the short headline).
    const citations: Citation[] = [];
    if (topSignal) {
      if (signalSentence && body.includes(signalSentence)) {
        citations.push({ sentence: signalSentence, signalId: topSignal.id });
      }
      if (signalShort && body.includes(signalShort)) {
        citations.push({ sentence: signalShort, signalId: topSignal.id });
      }
    }

    return { subject, body, citations };
  });

  return { touches, source: "fallback" };
}

/**
 * Build the user prompt for the gateway. Hands the LLM the system framing, the
 * grounded facts (signals with ids), the value prop, and a strict JSON contract.
 */
function buildPrompt(lib: VerticalPromptLibrary, ctx: ProspectContext): string {
  const signalLines = ctx.signals.length
    ? ctx.signals.map((s) => `- id=${s.id} | ${s.headline}`).join("\n")
    : "- (no signals on file — do not invent any)";

  const touchSpec = lib.touches
    .slice(0, TOUCH_COUNT)
    .map((t) => `  Touch ${t.index} (${t.label}, send day ${t.dayOffset}): ${t.goal} ${t.guidance}`)
    .join("\n");

  return [
    lib.systemPrompt,
    "",
    `Prospect: ${ctx.fullName} at ${ctx.company}.`,
    `Campaign value proposition: ${ctx.valueProp}`,
    "",
    "GROUNDING FACTS (the ONLY facts you may state about the prospect — each has an id):",
    signalLines,
    "",
    "Write a 3-touch cold email sequence:",
    touchSpec,
    "",
    "HARD RULES:",
    "- Any sentence that asserts a fact about the prospect or their company MUST be",
    "  backed by one of the grounding facts above, and you MUST list it in `citations`",
    "  with the exact sentence text and the fact's id.",
    "- Never invent funding, hiring, headcount, clients, or metrics about the prospect.",
    "- Generic value-prop language about what you offer does NOT need a citation.",
    `- Sign off as ${ctx.senderName}.`,
    "",
    "Respond with ONLY a JSON object of this exact shape (no prose, no markdown):",
    '{"touches":[{"subject":"...","body":"...","citations":[{"sentence":"...","signalId":"..."}]}]}',
    "There must be exactly 3 entries in `touches`, in order.",
  ].join("\n");
}

/**
 * Pull the first balanced JSON object out of a possibly-chatty LLM response.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function coerceTouches(parsed: unknown): DraftTouch[] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const touchesRaw = (parsed as { touches?: unknown }).touches;
  if (!Array.isArray(touchesRaw)) return null;

  const touches: DraftTouch[] = [];
  for (const raw of touchesRaw) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { subject?: unknown; body?: unknown; citations?: unknown };
    const subject = typeof r.subject === "string" ? r.subject.trim() : "";
    const body = typeof r.body === "string" ? r.body.trim() : "";
    if (!body) continue;
    const citations: Citation[] = Array.isArray(r.citations)
      ? r.citations
          .map((c) => {
            if (!c || typeof c !== "object") return null;
            const cc = c as { sentence?: unknown; signalId?: unknown; signal_id?: unknown };
            const sentence = typeof cc.sentence === "string" ? cc.sentence : "";
            const signalId =
              typeof cc.signalId === "string"
                ? cc.signalId
                : typeof cc.signal_id === "string"
                  ? cc.signal_id
                  : "";
            if (!sentence || !signalId) return null;
            return { sentence, signalId } as Citation;
          })
          .filter((c): c is Citation => c !== null)
      : [];
    touches.push({ subject, body, citations });
  }
  return touches.length >= TOUCH_COUNT ? touches.slice(0, TOUCH_COUNT) : null;
}

/** Pull drafted text out of the several response shapes a gateway may return. */
function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;

  // Anthropic messages: { content: [{ type: "text", text }] }
  if (Array.isArray(p.content)) {
    const parts = p.content
      .map((c) => (c && typeof c === "object" ? (c as { text?: unknown }).text : undefined))
      .filter((t): t is string => typeof t === "string");
    if (parts.length) return parts.join("\n");
  }
  // OpenAI-style: { choices: [{ message: { content } }] }
  if (Array.isArray(p.choices)) {
    const first = p.choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
    const content = first?.message?.content ?? first?.text;
    if (typeof content === "string") return content;
  }
  if (typeof p.output_text === "string") return p.output_text;
  if (typeof p.text === "string") return p.text;
  return "";
}

/**
 * Call the Nexus gateway for a structured 3-touch draft. Returns null on any
 * failure (missing config, network error, unparseable response) so the caller
 * can fall back to the deterministic drafter.
 */
async function callGateway(
  lib: VerticalPromptLibrary,
  ctx: ProspectContext,
  regenNote: string,
): Promise<SequenceDraft | null> {
  const url = process.env.NEXUS_GATEWAY_URL ?? process.env.LLM_GATEWAY_URL;
  if (!url) return null;
  const token = process.env.NEXUS_GATEWAY_TOKEN ?? process.env.LLM_GATEWAY_TOKEN ?? "";
  const model = process.env.NEXUS_SDR_MODEL ?? "claude-sonnet-5";

  const userPrompt = regenNote ? `${buildPrompt(lib, ctx)}\n\n${regenNote}` : buildPrompt(lib, ctx);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}`, "x-api-key": token } : {}),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        temperature: 0.4,
        system: lib.systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) {
      log("warn", "gateway_non_ok", { status: res.status });
      return null;
    }
    const payload = (await res.json()) as unknown;
    const text = extractText(payload);
    const json = extractJsonObject(text);
    if (!json) return null;
    const touches = coerceTouches(JSON.parse(json));
    if (!touches) return null;
    return { touches, source: "gateway" };
  } catch (err) {
    log("warn", "gateway_call_failed", { error: String((err as Error).message) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data access — campaigns, prospects, signals
// ─────────────────────────────────────────────────────────────────────────────

interface GenCampaign {
  id: string;
  organizationId: string;
  name: string;
  vertical: string | null;
  valueProp: string;
}

interface CampaignGenRow {
  id: string;
  organization_id: string;
  name: string;
  vertical: string | null;
  value_prop: string | null;
  offer: string | null;
}

function toGenCampaign(row: CampaignGenRow): GenCampaign {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    vertical: row.vertical,
    valueProp: (row.value_prop ?? row.offer ?? "").trim(),
  };
}

async function loadGenCampaigns(organizationId?: string, campaignId?: string): Promise<GenCampaign[]> {
  const db = buildDb();
  if (campaignId && organizationId) {
    const rows = await db.query<CampaignGenRow>(
      `SELECT id, organization_id, name, vertical, value_prop, offer
         FROM sdr_campaigns
        WHERE organization_id = $1 AND id = $2
        LIMIT 1`,
      organizationId,
      campaignId,
    );
    return rows.map(toGenCampaign);
  }
  const rows = organizationId
    ? await db.query<CampaignGenRow>(
        `SELECT id, organization_id, name, vertical, value_prop, offer
           FROM sdr_campaigns
          WHERE organization_id = $1 AND status = 'active'
          ORDER BY created_at ASC`,
        organizationId,
      )
    : await db.query<CampaignGenRow>(
        `SELECT id, organization_id, name, vertical, value_prop, offer
           FROM sdr_campaigns
          WHERE status = 'active'
          ORDER BY created_at ASC`,
      );
  return rows.map(toGenCampaign);
}

interface ProspectGenRow {
  id: string;
  first_name: string | null;
  full_name: string | null;
  email: string;
  company_name: string | null;
  title: string | null;
}

interface ProspectGen {
  id: string;
  firstName: string;
  fullName: string;
  email: string;
  company: string;
  title: string | null;
}

function toProspectGen(row: ProspectGenRow): ProspectGen {
  const full = row.full_name ?? [row.first_name].filter(Boolean).join(" ") ?? row.email;
  const first = (row.first_name ?? full.split(/\s+/)[0] ?? "there").trim() || "there";
  return {
    id: row.id,
    firstName: first,
    fullName: full || row.email,
    email: row.email,
    company: (row.company_name ?? "your firm").trim() || "your firm",
    title: row.title,
  };
}

/** Sourced prospects WITH signals and WITHOUT an existing sequence, best-fit first. */
async function pickProspects(campaign: GenCampaign, limit: number): Promise<ProspectGen[]> {
  const db = buildDb();
  const rows = await db.query<ProspectGenRow>(
    `SELECT p.id, p.first_name, p.full_name, p.email, p.company_name, p.title
       FROM sdr_prospects p
      WHERE p.organization_id = $1
        AND p.campaign_id = $2
        AND p.status = 'sourced'
        AND EXISTS (SELECT 1 FROM sdr_prospect_signals s WHERE s.prospect_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM sdr_sequences q WHERE q.prospect_id = p.id)
      ORDER BY p.fit_score DESC, p.created_at ASC
      LIMIT $3`,
    campaign.organizationId,
    campaign.id,
    limit,
  );
  return rows.map(toProspectGen);
}

interface SignalRowLite {
  id: string;
  type: string;
  headline: string;
  weight: number | string | null;
}

/** Load a prospect's signals strongest-first (used as grounding facts). */
async function loadSignalRefs(organizationId: string, prospectId: string): Promise<SignalRef[]> {
  const db = buildDb();
  const rows = await db.query<SignalRowLite>(
    `SELECT id, type, headline, weight
       FROM sdr_prospect_signals
      WHERE organization_id = $1 AND prospect_id = $2
      ORDER BY weight DESC, observed_at DESC`,
    organizationId,
    prospectId,
  );
  return rows.map((r) => ({ id: r.id, headline: r.headline, type: r.type }));
}

/** Has the founder already approved this (campaign, segment)? → autonomous. */
async function hasSegmentApproval(
  organizationId: string,
  campaignId: string,
  segment: string,
): Promise<boolean> {
  const db = buildDb();
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM sdr_segment_approvals
      WHERE organization_id = $1 AND campaign_id = $2 AND segment_key = $3
      LIMIT 1`,
    organizationId,
    campaignId,
    segment,
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-prospect generation + persistence
// ─────────────────────────────────────────────────────────────────────────────

function senderName(): string {
  return process.env.SDR_SENDER_NAME ?? "The Team";
}

interface GroundedTouch {
  subject: string;
  body: string;
  citations: Array<Citation & { headline: string }>;
}

/**
 * Draft + ground a 3-touch sequence for one prospect. Tries the gateway, falls
 * back to the deterministic drafter, and regenerates up to MAX_REGENERATIONS when
 * grounding fails. Returns null when it could not produce a grounded sequence.
 */
async function draftGroundedSequence(
  lib: VerticalPromptLibrary,
  ctx: ProspectContext,
): Promise<GroundedTouch[] | null> {
  for (let attempt = 0; attempt <= MAX_REGENERATIONS; attempt += 1) {
    const regenNote =
      attempt === 0
        ? ""
        : "A previous attempt made an ungrounded factual claim. Re-write so EVERY factual claim about the prospect is backed by one of the grounding facts and listed in citations.";

    const draft = (await callGateway(lib, ctx, regenNote)) ?? fallbackDraft(lib, ctx);

    const prospectRef = { company: ctx.company, firstName: ctx.firstName };
    const grounded: GroundedTouch[] = [];
    let allGrounded = true;
    for (const touch of draft.touches) {
      const result = checkGrounding({
        body: touch.body,
        citations: touch.citations,
        signals: ctx.signals,
        prospect: prospectRef,
      });
      if (!result.grounded) {
        allGrounded = false;
        log("warn", "touch_ungrounded", {
          attempt,
          source: draft.source,
          uncited: result.uncitedClaims.length,
          invalid: result.invalidCitations.length,
        });
        break;
      }
      grounded.push({
        subject: touch.subject,
        body: touch.body,
        citations: sanitizeCitations(touch.body, touch.citations, ctx.signals),
      });
    }

    if (allGrounded && grounded.length === draft.touches.length) {
      return grounded;
    }

    // If the gateway produced ungrounded copy, next loop retries; but if we are on
    // the last attempt, fall back to the deterministic drafter which is grounded
    // by construction before giving up.
    if (attempt === MAX_REGENERATIONS) {
      const fb = fallbackDraft(lib, ctx);
      const grounded2: GroundedTouch[] = [];
      let ok = true;
      for (const touch of fb.touches) {
        const result = checkGrounding({
          body: touch.body,
          citations: touch.citations,
          signals: ctx.signals,
          prospect: prospectRef,
        });
        if (!result.grounded) {
          ok = false;
          break;
        }
        grounded2.push({
          subject: touch.subject,
          body: touch.body,
          citations: sanitizeCitations(touch.body, touch.citations, ctx.signals),
        });
      }
      if (ok) return grounded2;
    }
  }
  return null;
}

interface ProspectOutcome {
  created: boolean;
  dropped: boolean;
  autonomous: boolean;
}

async function generateForProspect(
  campaign: GenCampaign,
  prospect: ProspectGen,
  nowMs: number,
): Promise<ProspectOutcome> {
  const lib = resolveLibrary(campaign.vertical);
  const signals = await loadSignalRefs(campaign.organizationId, prospect.id);
  if (signals.length === 0) {
    return { created: false, dropped: true, autonomous: false };
  }

  const ctx: ProspectContext = {
    firstName: prospect.firstName,
    fullName: prospect.fullName,
    company: prospect.company,
    valueProp: campaign.valueProp || lib.valueProps[0],
    senderName: senderName(),
    signals,
  };

  const touches = await draftGroundedSequence(lib, ctx);
  if (!touches) {
    log("warn", "sequence_dropped", { prospectId: prospect.id, reason: "ungrounded" });
    return { created: false, dropped: true, autonomous: false };
  }

  const segment = segmentKey(campaign.vertical, prospect.title);
  const autonomous = await hasSegmentApproval(campaign.organizationId, campaign.id, segment);

  const db = buildDb();
  const sequenceId = randomUUID();
  const seqStatus: SequenceStatus = autonomous ? "active" : "pending_approval";
  const nextSendAt = autonomous ? new Date(nowMs).toISOString() : null;

  await db.execute(
    `INSERT INTO sdr_sequences
       (id, organization_id, prospect_id, campaign_id, segment_key, status, touch_count, next_send_at, autonomous)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (prospect_id) DO NOTHING`,
    sequenceId,
    campaign.organizationId,
    prospect.id,
    campaign.id,
    segment,
    seqStatus,
    touches.length,
    nextSendAt,
    autonomous,
  );

  const msgStatus: MessageStatus = autonomous ? "queued" : "draft";
  for (let i = 0; i < touches.length; i += 1) {
    const touch = touches[i];
    const dayOffset = TOUCH_DAY_OFFSETS[i] ?? i * 3;
    const touchSendAt = autonomous ? new Date(nowMs + dayOffset * 86_400_000).toISOString() : null;
    await db.execute(
      `INSERT INTO sdr_messages
         (id, organization_id, campaign_id, prospect_id, sequence_id, provider, direction,
          touch_index, subject, body_text, signal_citations, status, next_send_at)
       VALUES ($1, $2, $3, $4, $5, 'gmail', 'outbound', $6, $7, $8, $9::jsonb, $10, $11)`,
      randomUUID(),
      campaign.organizationId,
      campaign.id,
      prospect.id,
      sequenceId,
      i,
      touch.subject,
      touch.body,
      JSON.stringify(touch.citations),
      msgStatus,
      touchSendAt,
    );
  }

  await db.execute(
    `UPDATE sdr_prospects SET status = 'sequenced', updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND status = 'sourced'`,
    prospect.id,
    campaign.organizationId,
  );

  log("info", "sequence_created", {
    prospectId: prospect.id,
    segment,
    autonomous,
    touches: touches.length,
  });
  return { created: true, dropped: false, autonomous };
}

export interface GenerateSummary {
  campaigns: number;
  considered: number;
  created: number;
  dropped: number;
  autonomous: number;
  pendingApproval: number;
}

/**
 * Main entry — drafts grounded sequences for sourced prospects across active
 * campaigns. Called by the Vercel cron and the immediate-on-source trigger.
 */
export async function generateSequences(params: {
  organizationId?: string;
  campaignId?: string;
  limitPerCampaign?: number;
  nowMs: number;
}): Promise<GenerateSummary> {
  const limit = Math.min(Math.max(params.limitPerCampaign ?? 25, 1), 200);
  const campaigns = await loadGenCampaigns(params.organizationId, params.campaignId);

  const summary: GenerateSummary = {
    campaigns: campaigns.length,
    considered: 0,
    created: 0,
    dropped: 0,
    autonomous: 0,
    pendingApproval: 0,
  };

  for (const campaign of campaigns) {
    let prospects: ProspectGen[];
    try {
      prospects = await pickProspects(campaign, limit);
    } catch (err) {
      log("error", "pick_prospects_failed", { campaignId: campaign.id, error: String((err as Error).message) });
      continue;
    }

    for (const prospect of prospects) {
      summary.considered += 1;
      try {
        const outcome = await generateForProspect(campaign, prospect, params.nowMs);
        if (outcome.created) {
          summary.created += 1;
          if (outcome.autonomous) summary.autonomous += 1;
          else summary.pendingApproval += 1;
        } else if (outcome.dropped) {
          summary.dropped += 1;
        }
      } catch (err) {
        summary.dropped += 1;
        log("error", "generate_for_prospect_failed", {
          prospectId: prospect.id,
          error: String((err as Error).message),
        });
      }
    }
  }

  log("info", "generate_sequences_done", { ...summary });
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval surface — read/write helpers for the /approvals page + actions
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingSequenceRow {
  id: string;
  prospectId: string;
  prospectName: string;
  company: string;
  title: string | null;
  email: string;
  segmentKey: string;
  campaignId: string | null;
  campaignName: string | null;
  subject: string;
  snippet: string;
  createdAt: string;
}

/** List sequences awaiting first-send approval, newest first. */
export async function listPendingSequences(organizationId: string): Promise<PendingSequenceRow[]> {
  const db = buildDb();
  const rows = await db.query<{
    id: string;
    prospect_id: string;
    prospect_name: string | null;
    company: string | null;
    title: string | null;
    email: string;
    segment_key: string;
    campaign_id: string | null;
    campaign_name: string | null;
    subject: string | null;
    body_text: string | null;
    created_at: string | Date;
  }>(
    `SELECT q.id, q.prospect_id, p.full_name AS prospect_name, p.company_name AS company,
            p.title, p.email, q.segment_key, q.campaign_id, c.name AS campaign_name,
            m.subject, m.body_text, q.created_at
       FROM sdr_sequences q
       JOIN sdr_prospects p ON p.id = q.prospect_id
       LEFT JOIN sdr_campaigns c ON c.id = q.campaign_id
       LEFT JOIN sdr_messages m ON m.sequence_id = q.id AND m.touch_index = 0
      WHERE q.organization_id = $1 AND q.status = 'pending_approval'
      ORDER BY q.created_at DESC
      LIMIT 200`,
    organizationId,
  );
  return rows.map((r) => ({
    id: r.id,
    prospectId: r.prospect_id,
    prospectName: r.prospect_name ?? r.email,
    company: r.company ?? "—",
    title: r.title,
    email: r.email,
    segmentKey: r.segment_key,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    subject: r.subject ?? "(no subject)",
    snippet: (r.body_text ?? "").replace(/\s+/g, " ").slice(0, 120),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export interface ApprovalMessage {
  id: string;
  touchIndex: number;
  subject: string;
  body: string;
  status: string;
  citations: Array<{ sentence: string; signalId: string; headline: string }>;
}

export interface ApprovalDetail {
  sequenceId: string;
  status: string;
  prospectId: string;
  prospectName: string;
  company: string;
  title: string | null;
  email: string;
  segmentKey: string;
  campaignId: string | null;
  messages: ApprovalMessage[];
  signals: SignalRef[];
}

function parseCitations(raw: unknown): Array<{ sentence: string; signalId: string; headline: string }> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: Array<{ sentence: string; signalId: string; headline: string }> = [];
  for (const c of value) {
    if (!c || typeof c !== "object") continue;
    const cc = c as { sentence?: unknown; signalId?: unknown; headline?: unknown };
    if (typeof cc.sentence === "string" && typeof cc.signalId === "string") {
      out.push({
        sentence: cc.sentence,
        signalId: cc.signalId,
        headline: typeof cc.headline === "string" ? cc.headline : "",
      });
    }
  }
  return out;
}

/** Full detail for one sequence: all touches + the prospect's grounding signals. */
export async function getApprovalDetail(
  organizationId: string,
  sequenceId: string,
): Promise<ApprovalDetail | null> {
  const db = buildDb();
  const seqRows = await db.query<{
    id: string;
    status: string;
    prospect_id: string;
    segment_key: string;
    campaign_id: string | null;
    prospect_name: string | null;
    company: string | null;
    title: string | null;
    email: string;
  }>(
    `SELECT q.id, q.status, q.prospect_id, q.segment_key, q.campaign_id,
            p.full_name AS prospect_name, p.company_name AS company, p.title, p.email
       FROM sdr_sequences q
       JOIN sdr_prospects p ON p.id = q.prospect_id
      WHERE q.organization_id = $1 AND q.id = $2
      LIMIT 1`,
    organizationId,
    sequenceId,
  );
  const seq = seqRows[0];
  if (!seq) return null;

  const msgRows = await db.query<{
    id: string;
    touch_index: number;
    subject: string | null;
    body_text: string | null;
    status: string;
    signal_citations: unknown;
  }>(
    `SELECT id, touch_index, subject, body_text, status, signal_citations
       FROM sdr_messages
      WHERE organization_id = $1 AND sequence_id = $2
      ORDER BY touch_index ASC`,
    organizationId,
    sequenceId,
  );

  const signals = await loadSignalRefs(organizationId, seq.prospect_id);

  return {
    sequenceId: seq.id,
    status: seq.status,
    prospectId: seq.prospect_id,
    prospectName: seq.prospect_name ?? seq.email,
    company: seq.company ?? "—",
    title: seq.title,
    email: seq.email,
    segmentKey: seq.segment_key,
    campaignId: seq.campaign_id,
    signals,
    messages: msgRows.map((m) => ({
      id: m.id,
      touchIndex: m.touch_index,
      subject: m.subject ?? "",
      body: m.body_text ?? "",
      status: m.status,
      citations: parseCitations(m.signal_citations),
    })),
  };
}

export interface SegmentProgress {
  approved: number;
  threshold: number;
  unlocked: boolean;
  pending: number;
}

/** Approval progress for a segment — drives the "Approve 5 to unlock" ring. */
export async function segmentProgress(
  organizationId: string,
  campaignId: string | null,
  segment: string,
): Promise<SegmentProgress> {
  const db = buildDb();
  const approvedRows = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sdr_sequences
      WHERE organization_id = $1 AND segment_key = $2 AND status = 'active'
        AND ($3::uuid IS NULL OR campaign_id = $3)`,
    organizationId,
    segment,
    campaignId,
  );
  const pendingRows = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sdr_sequences
      WHERE organization_id = $1 AND segment_key = $2 AND status = 'pending_approval'
        AND ($3::uuid IS NULL OR campaign_id = $3)`,
    organizationId,
    segment,
    campaignId,
  );
  const unlocked =
    campaignId !== null && (await hasSegmentApproval(organizationId, campaignId, segment));
  return {
    approved: Number(approvedRows[0]?.n ?? 0),
    threshold: SEGMENT_UNLOCK_THRESHOLD,
    unlocked,
    pending: Number(pendingRows[0]?.n ?? 0),
  };
}

/**
 * Whether the user has acknowledged the Acceptable Use Policy via
 * @nexus/legal-and-compliance. Approval is blocked until this returns true.
 */
export async function isAupAcknowledged(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const result = await handleMissingAcknowledgments({
      userId,
      query: { jurisdiction: "us" },
      ctx: { db: buildDb(), events: buildEventBus() },
    });
    if (result.status !== 200 || !result.body || typeof result.body !== "object") {
      return false;
    }
    const missing = (result.body as { missing?: Array<{ doc_type?: string }> }).missing ?? [];
    // Acknowledged iff the AUP is NOT in the still-missing list.
    return !missing.some((m) => (m.doc_type ?? "").toLowerCase().includes("acceptable_use"));
  } catch (err) {
    log("error", "aup_check_failed", { error: String((err as Error).message) });
    return false;
  }
}

export interface TouchEdit {
  messageId: string;
  subject: string;
  body: string;
}

/** Persist inline edits to a sequence's touches (subject + body), re-grounding citations. */
async function applyEdits(
  organizationId: string,
  sequenceId: string,
  edits: TouchEdit[],
  signals: SignalRef[],
): Promise<void> {
  if (edits.length === 0) return;
  const db = buildDb();
  for (const edit of edits) {
    // Re-ground: keep only citations whose sentence still appears in the edited body.
    const existing = await db.query<{ signal_citations: unknown }>(
      `SELECT signal_citations FROM sdr_messages
        WHERE organization_id = $1 AND id = $2 AND sequence_id = $3
        LIMIT 1`,
      organizationId,
      edit.messageId,
      sequenceId,
    );
    const prior = parseCitations(existing[0]?.signal_citations).map((c) => ({
      sentence: c.sentence,
      signalId: c.signalId,
    }));
    const sanitized = sanitizeCitations(edit.body, prior, signals);
    await db.execute(
      `UPDATE sdr_messages
          SET subject = $1, body_text = $2, signal_citations = $3::jsonb, updated_at = NOW()
        WHERE organization_id = $4 AND id = $5 AND sequence_id = $6`,
      edit.subject,
      edit.body,
      JSON.stringify(sanitized),
      organizationId,
      edit.messageId,
      sequenceId,
    );
  }
}

/** Queue a sequence's touches with the fixed cadence, starting now. */
async function queueSequence(organizationId: string, sequenceId: string): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_sequences
        SET status = 'active', next_send_at = NOW(), updated_at = NOW()
      WHERE organization_id = $1 AND id = $2 AND status = 'pending_approval'`,
    organizationId,
    sequenceId,
  );
  for (let i = 0; i < TOUCH_DAY_OFFSETS.length; i += 1) {
    await db.execute(
      `UPDATE sdr_messages
          SET status = 'queued', next_send_at = NOW() + ($1 * INTERVAL '1 day'), updated_at = NOW()
        WHERE organization_id = $2 AND sequence_id = $3 AND touch_index = $4
          AND status IN ('draft', 'approved')`,
      TOUCH_DAY_OFFSETS[i],
      organizationId,
      sequenceId,
      i,
    );
  }
}

async function maybeUnlockSegment(
  organizationId: string,
  campaignId: string | null,
  segment: string,
  approverId: string,
  approverEmail: string,
): Promise<boolean> {
  if (!campaignId) return false;
  if (await hasSegmentApproval(organizationId, campaignId, segment)) return true;

  const progress = await segmentProgress(organizationId, campaignId, segment);
  if (progress.approved < SEGMENT_UNLOCK_THRESHOLD) return false;

  await insertSegmentApproval(organizationId, campaignId, segment, approverId, approverEmail);
  return true;
}

async function insertSegmentApproval(
  organizationId: string,
  campaignId: string,
  segment: string,
  approverId: string,
  approverEmail: string,
): Promise<void> {
  const db = buildDb();
  const sampleRows = await db.query<{ id: string }>(
    `SELECT m.id
       FROM sdr_messages m
       JOIN sdr_sequences q ON q.id = m.sequence_id
      WHERE q.organization_id = $1 AND q.campaign_id = $2 AND q.segment_key = $3
        AND q.status = 'active' AND m.touch_index = 0
      ORDER BY q.updated_at DESC
      LIMIT 10`,
    organizationId,
    campaignId,
    segment,
  );
  const sampleIds = sampleRows.map((r) => r.id);
  await db.execute(
    `INSERT INTO sdr_segment_approvals
       (id, organization_id, campaign_id, segment_key, approved_by, approved_by_email, sample_message_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (organization_id, campaign_id, segment_key) DO NOTHING`,
    randomUUID(),
    organizationId,
    campaignId,
    segment,
    approverId || null,
    approverEmail || null,
    JSON.stringify(sampleIds),
  );
  log("info", "segment_unlocked", { campaignId, segment, samples: sampleIds.length });
}

export interface ApproveResult {
  ok: boolean;
  error?: string;
  unlocked: boolean;
  approved: number;
}

/**
 * Approve one sequence's first batch: save inline edits, queue the touches, and —
 * once the segment hits the unlock threshold — write the segment approval so
 * subsequent sequences in that segment send autonomously.
 */
export async function approveSequence(params: {
  organizationId: string;
  approverId: string;
  approverEmail: string;
  sequenceId: string;
  edits: TouchEdit[];
}): Promise<ApproveResult> {
  const { organizationId, approverId, approverEmail, sequenceId, edits } = params;
  const detail = await getApprovalDetail(organizationId, sequenceId);
  if (!detail) return { ok: false, error: "not_found", unlocked: false, approved: 0 };
  if (detail.status !== "pending_approval") {
    return { ok: false, error: "not_pending", unlocked: false, approved: 0 };
  }

  await applyEdits(organizationId, sequenceId, edits, detail.signals);
  await queueSequence(organizationId, sequenceId);

  const unlocked = await maybeUnlockSegment(
    organizationId,
    detail.campaignId,
    detail.segmentKey,
    approverId,
    approverEmail,
  );
  const progress = await segmentProgress(organizationId, detail.campaignId, detail.segmentKey);
  return { ok: true, unlocked, approved: progress.approved };
}

/**
 * Explicitly approve the whole segment now (unlock even with fewer than the
 * threshold reviewed) — queues every pending sequence in the segment.
 */
export async function approveSegment(params: {
  organizationId: string;
  approverId: string;
  approverEmail: string;
  campaignId: string;
  segmentKey: string;
}): Promise<ApproveResult> {
  const { organizationId, approverId, approverEmail, campaignId, segmentKey: segment } = params;
  const db = buildDb();
  const pending = await db.query<{ id: string }>(
    `SELECT id FROM sdr_sequences
      WHERE organization_id = $1 AND campaign_id = $2 AND segment_key = $3
        AND status = 'pending_approval'`,
    organizationId,
    campaignId,
    segment,
  );
  for (const row of pending) {
    await queueSequence(organizationId, row.id);
  }
  await insertSegmentApproval(organizationId, campaignId, segment, approverId, approverEmail);
  const progress = await segmentProgress(organizationId, campaignId, segment);
  return { ok: true, unlocked: true, approved: progress.approved };
}

/** Skip (cancel) a sequence — it will not be sent. */
export async function skipSequence(organizationId: string, sequenceId: string): Promise<ApproveResult> {
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_sequences SET status = 'cancelled', next_send_at = NULL, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2 AND status = 'pending_approval'`,
    organizationId,
    sequenceId,
  );
  await db.execute(
    `UPDATE sdr_messages SET status = 'cancelled', next_send_at = NULL, updated_at = NOW()
      WHERE organization_id = $1 AND sequence_id = $2 AND status IN ('draft', 'approved')`,
    organizationId,
    sequenceId,
  );
  log("info", "sequence_skipped", { sequenceId });
  return { ok: true, unlocked: false, approved: 0 };
}
