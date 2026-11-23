/**
 * Vertical prompt library — ACCOUNTING (CPA firms / fractional finance).
 *
 * One of the three libraries ceo_briefing.data_findings[1] requires. Consumed by
 * apps/web/lib/sdr/sequence-generator.ts exactly like the legal library: the
 * `systemPrompt` + per-touch `guidance` steer the gateway LLM, and the
 * `fallbackTemplate` strings deterministically compose grounded, cited copy when
 * the gateway is unavailable.
 *
 * All recipient-specific claims MUST cite an sdr_prospect_signals row; this file
 * only supplies value framing and tone.
 */

import type { VerticalPromptLibrary } from "@/lib/sdr/sequence-generator";

export const ACCOUNTING_PROMPTS: VerticalPromptLibrary = {
  key: "accounting",
  label: "Accounting",
  audience:
    "Partners and practice leads at US CPA firms, plus Controllers and fractional-CFO practices.",
  systemPrompt: [
    "You are an SDR for a workflow-automation advisory that serves accounting and finance teams.",
    "Your reader is numerate, skeptical, and allergic to vague ROI claims.",
    "Write concretely: name the workflow, name the saved hours, cite the grounding signal.",
    "Never fabricate a figure about the reader's firm — only use supplied signals.",
    "One ask per email, quantified where possible.",
  ].join(" "),
  valueProps: [
    "cut month-end close from days to hours",
    "eliminate manual reconciliation and re-keying across systems",
    "free senior staff from low-value compliance grind during busy season",
  ],
  painPoints: [
    "busy-season capacity crunch and staff burnout",
    "manual reconciliation eating billable advisory time",
    "clients expecting real-time numbers the current stack can't deliver",
  ],
  proofPoints: [
    "a 25-person CPA firm reclaimed ~30 staff-hours per close cycle",
    "reconciliation error rates dropped to near-zero after automation",
    "firms added advisory revenue without hiring through busy season",
  ],
  subjectPatterns: [
    "{{company}} + a faster close",
    "Busy-season capacity at {{company}}",
    "{{firstName}} — after {{signalShort}}",
  ],
  touches: [
    {
      index: 0,
      label: "Intro email",
      dayOffset: 0,
      goal: "Open with a grounded signal and tie it to a quantifiable finance pain.",
      guidance:
        "Lead with the strongest signal as a neutral observation. Connect it to one measurable pain (close time, capacity, reconciliation). Ask one low-friction question. No demo pitch.",
      fallbackTemplate:
        "Hi {{firstName}},\n\n{{signalSentence}} That's usually when {{painPoint}} starts to bite at a firm like {{company}}.\n\nWe help accounting teams {{valueProp}} — {{proofPoint}}. Is that worth a quick reply?\n\nBest,\n{{senderName}}",
    },
    {
      index: 1,
      label: "Value follow-up",
      dayOffset: 3,
      goal: "Reinforce with one concrete, numeric proof point tied to the signal.",
      guidance:
        "Briefly reference the first email. Add one numeric proof point relevant to the signal. Keep under 90 words. Re-ask, rephrased.",
      fallbackTemplate:
        "Hi {{firstName}},\n\nQuick follow-up. Given {{signalShort}}, the lever that tends to move fastest at {{company}} is close time — {{proofPoint}}.\n\nHappy to walk through the before/after, or to pause if now's not it. Which works?\n\n{{senderName}}",
    },
    {
      index: 2,
      label: "Break-up",
      dayOffset: 7,
      goal: "Respectful last touch that invites a reply or a clean opt-out.",
      guidance:
        "Three sentences max. No new claims. Make opting out effortless.",
      fallbackTemplate:
        "Hi {{firstName}},\n\nI'll stop here so I'm not adding to the pile. If freeing up capacity at {{company}} climbs the list, just reply and I'll pick it back up.\n\nWishing you a smooth close.\n\n{{senderName}}",
    },
  ],
  complianceNotes: [
    "No guarantees of audit outcomes, tax savings, or regulatory results.",
    "No claims about the firm's specific clients.",
    "US-only outreach; honor opt-outs immediately.",
  ],
};

export default ACCOUNTING_PROMPTS;
