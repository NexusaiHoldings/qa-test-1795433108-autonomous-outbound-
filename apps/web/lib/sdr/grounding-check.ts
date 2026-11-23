/**
 * Grounding check (F1-005).
 *
 * The direct mitigation for feasibility_analysis.key_technical_risks[2]
 * (LLM hallucination in outbound copy): every FACTUAL CLAIM a drafted email makes
 * about the prospect must cite an sdr_prospect_signals.id. Uncited claims make the
 * draft fail this gate, which triggers regeneration in the sequence generator; if
 * regeneration still fails, the sequence is dropped rather than sent.
 *
 * Pure, synchronous, no I/O — so it is deterministic and unit-testable. The
 * generator supplies the drafted body, the LLM's claimed citations, and the set of
 * real signals for the prospect; this module decides whether the body is grounded.
 */

export interface SignalRef {
  id: string;
  headline: string;
  type?: string;
}

export interface Citation {
  /** The exact personalized sentence the LLM claims is grounded. */
  sentence: string;
  /** The sdr_prospect_signals.id that grounds it. */
  signalId: string;
}

export interface AnnotatedSentence {
  text: string;
  /** Non-null when this sentence is a grounded factual claim. */
  signalId: string | null;
  headline: string | null;
  /** True when the sentence reads as a factual claim about the prospect. */
  isClaim: boolean;
}

export interface GroundingResult {
  grounded: boolean;
  /** Factual-claim sentences that lack a valid signal citation. */
  uncitedClaims: string[];
  /** Citations pointing at a signal id that is not real for this prospect. */
  invalidCitations: Citation[];
  /** Per-sentence annotation for the approval UI (underline + hover popover). */
  annotations: AnnotatedSentence[];
}

/**
 * Words/patterns that mark a sentence as a factual claim ABOUT THE PROSPECT —
 * the kind of statement that, if ungrounded, is a hallucination risk. Generic
 * value-prop language ("we help teams recover hours") is intentionally NOT here.
 */
const CLAIM_KEYWORDS: readonly string[] = [
  "raised",
  "raise",
  "funding",
  "round",
  "series ",
  "seed",
  "valuation",
  "acquired",
  "acquisition",
  "merged",
  "merger",
  "hiring",
  "hired",
  "headcount",
  "opened",
  "expanding",
  "expanded",
  "new office",
  "launched",
  "launching",
  "announced",
  "promoted",
  "appointed",
  "named",
  "joined",
  "grew",
  "growth",
  "doubled",
  "partnership",
  "award",
  "recognized",
];

/** A numeric / money / percentage mention is almost always a concrete claim. */
const NUMERIC_CLAIM = /(\$\s?\d|\d+\s?%|\b\d{2,}\b|\bseries\s+[a-e]\b)/i;

/**
 * Generic business words that do NOT identify a specific prospect (so a proof
 * point like "a 40-attorney firm…" is not mistaken for a claim ABOUT the
 * prospect just because it contains the word "firm").
 */
const COMPANY_IGNORE = new Set([
  "firm", "firms", "company", "companies", "team", "teams", "inc", "llc", "llp",
  "group", "corp", "ltd", "the", "your", "co",
]);

export interface ProspectRefContext {
  company?: string | null;
  firstName?: string | null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 %$]/g, "")
    .trim();
}

/**
 * Split a body into sentence-like units. We keep it simple and dependency-free:
 * split on sentence terminators and newlines, drop empties.
 */
export function extractSentences(body: string): string[] {
  return body
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hasClaimMarker(sentence: string, norm: string): boolean {
  if (NUMERIC_CLAIM.test(sentence)) return true;
  for (const kw of CLAIM_KEYWORDS) {
    if (norm.includes(kw.trim())) return true;
  }
  return false;
}

/** Company name tokens that actually identify the prospect (generic words dropped). */
function companyTokens(company: string | null | undefined): string[] {
  if (!company) return [];
  return normalize(company)
    .split(" ")
    .filter((t) => t.length >= 4 && !COMPANY_IGNORE.has(t));
}

/**
 * Does this sentence reference THE PROSPECT specifically — by naming their company
 * or by echoing their signal headlines? Generic third-party examples do not.
 */
function referencesProspect(
  norm: string,
  signals: SignalRef[],
  prospect?: ProspectRefContext,
): boolean {
  const normTokens = new Set(distinctiveTokens(norm));
  for (const t of companyTokens(prospect?.company)) {
    if (normTokens.has(t)) return true;
  }
  for (const sig of signals) {
    if (shareDistinctiveTokens(norm, normalize(sig.headline))) return true;
  }
  return false;
}

/**
 * A sentence is a factual claim we must ground only when it BOTH asserts something
 * concrete (a number or claim verb) AND is about the prospect (names their company
 * or restates a signal). This spares generic value-prop / proof-point copy while
 * still catching fabricated facts about the recipient.
 */
export function isFactualClaim(
  sentence: string,
  signals: SignalRef[],
  prospect?: ProspectRefContext,
): boolean {
  const norm = normalize(sentence);
  if (!norm) return false;
  if (!hasClaimMarker(sentence, norm)) return false;
  return referencesProspect(norm, signals, prospect);
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "at",
  "is", "are", "was", "were", "has", "have", "that", "this", "it", "as", "by",
  "from", "we", "you", "your", "our", "their", "they", "i", "me", "my", "its",
]);

function distinctiveTokens(norm: string): string[] {
  return norm
    .split(" ")
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

/** True when two normalized strings share >=2 distinctive (content) tokens. */
function shareDistinctiveTokens(a: string, b: string): boolean {
  const setB = new Set(distinctiveTokens(b));
  let shared = 0;
  for (const t of distinctiveTokens(a)) {
    if (setB.has(t)) {
      shared += 1;
      if (shared >= 2) return true;
    }
  }
  return false;
}

/** Fuzzy match a citation's sentence to an actual body sentence. */
function citationMatchesSentence(citationSentence: string, bodySentence: string): boolean {
  const c = normalize(citationSentence);
  const s = normalize(bodySentence);
  if (!c || !s) return false;
  if (c === s) return true;
  if (s.includes(c) || c.includes(s)) return true;
  return shareDistinctiveTokens(c, s);
}

/**
 * Validate that every factual claim in `body` is backed by a citation whose
 * signalId is a real signal for this prospect. Returns the full result including
 * per-sentence annotations for the approval UI.
 */
export function checkGrounding(params: {
  body: string;
  citations: Citation[];
  signals: SignalRef[];
  prospect?: ProspectRefContext;
}): GroundingResult {
  const { body, citations, signals, prospect } = params;
  const signalById = new Map(signals.map((s) => [s.id, s]));

  const validCitations: Citation[] = [];
  const invalidCitations: Citation[] = [];
  for (const c of citations) {
    if (c.signalId && signalById.has(c.signalId) && c.sentence && c.sentence.trim()) {
      validCitations.push(c);
    } else {
      invalidCitations.push(c);
    }
  }

  const sentences = extractSentences(body);
  const uncitedClaims: string[] = [];
  const annotations: AnnotatedSentence[] = [];

  for (const sentence of sentences) {
    const claim = isFactualClaim(sentence, signals, prospect);
    const hit = validCitations.find((c) => citationMatchesSentence(c.sentence, sentence));
    const sig = hit ? signalById.get(hit.signalId) ?? null : null;

    annotations.push({
      text: sentence,
      signalId: sig ? sig.id : null,
      headline: sig ? sig.headline : null,
      isClaim: claim,
    });

    if (claim && !sig) {
      uncitedClaims.push(sentence);
    }
  }

  const grounded = uncitedClaims.length === 0 && invalidCitations.length === 0;
  return { grounded, uncitedClaims, invalidCitations, annotations };
}

/**
 * Keep only citations that actually resolve to a real signal AND match a sentence
 * in the body — the normalized form persisted to sdr_messages.signal_citations.
 */
export function sanitizeCitations(
  body: string,
  citations: Citation[],
  signals: SignalRef[],
): Array<Citation & { headline: string }> {
  const signalById = new Map(signals.map((s) => [s.id, s]));
  const sentences = extractSentences(body);
  const out: Array<Citation & { headline: string }> = [];
  const seen = new Set<string>();

  for (const c of citations) {
    const sig = c.signalId ? signalById.get(c.signalId) : undefined;
    if (!sig) continue;
    const match = sentences.find((s) => citationMatchesSentence(c.sentence, s));
    if (!match) continue;
    const key = `${match}::${sig.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sentence: match, signalId: sig.id, headline: sig.headline });
  }
  return out;
}
