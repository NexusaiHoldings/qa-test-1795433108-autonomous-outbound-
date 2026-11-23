/**
 * Vertical prompt library — LEGAL (law firms / in-house counsel).
 *
 * One of the three libraries ceo_briefing.data_findings[1] requires. The grounded
 * sequence generator (apps/web/lib/sdr/sequence-generator.ts) loads the library
 * matching a campaign's vertical, feeds `systemPrompt` + the touch `guidance` to
 * the Nexus gateway, and — when the gateway is unavailable — composes copy from
 * the deterministic `fallbackTemplate` strings so the cron always produces real,
 * grounded, cited email bodies (never a stub).
 *
 * Every claim the copy makes about the prospect MUST trace back to an
 * sdr_prospect_signals row; the vertical library only supplies value framing and
 * tone, never fabricated facts about the recipient.
 */

import type { VerticalPromptLibrary } from "@/lib/sdr/sequence-generator";

export const LEGAL_PROMPTS: VerticalPromptLibrary = {
  key: "legal",
  label: "Legal",
  audience:
    "Managing partners, practice-group leads, and in-house General Counsel at US law firms and legal departments.",
  systemPrompt: [
    "You are an SDR writing on behalf of a boutique practice-management and legal-ops advisory.",
    "Your reader is a busy attorney who bills by the hour and distrusts marketing fluff.",
    "Write in plain, precise English — short sentences, no legalese theatre, no exclamation marks.",
    "Every specific claim about the reader's firm MUST be grounded in a supplied signal; never invent facts.",
    "Lead with the reader's situation, not your product. One clear ask per email.",
  ].join(" "),
  valueProps: [
    "recover billable hours lost to manual intake and conflicts checks",
    "shorten matter-opening cycle time without adding headcount",
    "turn after-hours admin into realized revenue",
  ],
  painPoints: [
    "partners drowning in non-billable intake and scheduling",
    "associate churn driven by repetitive administrative load",
    "revenue leakage from unbilled or write-down time",
  ],
  proofPoints: [
    "comparable firms recovered 6–9 billable hours per attorney each week",
    "a 40-attorney firm cut matter-opening time from 3 days to same-day",
    "zero new hires required — the work simply stops hitting partners' desks",
  ],
  subjectPatterns: [
    "{{company}} + billable hours",
    "A quieter intake queue for {{company}}",
    "{{firstName}} — quick note after {{signalShort}}",
  ],
  touches: [
    {
      index: 0,
      label: "Intro email",
      dayOffset: 0,
      goal: "Earn a reply with one grounded, specific observation and a soft ask.",
      guidance:
        "Open with the strongest signal, stated as an observation (not a boast). Connect it in one sentence to a concrete pain a firm at this stage feels. Close with a low-friction question — never a demo pitch.",
      fallbackTemplate:
        "Hi {{firstName}},\n\n{{signalSentence}} Firms hitting that stage usually feel it first in {{painPoint}}.\n\nWe help legal teams {{valueProp}} — {{proofPoint}}. Worth a short note back if that's on your radar at {{company}}?\n\nBest,\n{{senderName}}",
    },
    {
      index: 1,
      label: "Value follow-up",
      dayOffset: 3,
      goal: "Add one proof point tied to the same signal and keep the thread warm.",
      guidance:
        "Reference the first email briefly. Introduce a single, concrete proof point tied to the signal. Stay under 90 words. Re-ask the same question, phrased differently.",
      fallbackTemplate:
        "Hi {{firstName}},\n\nFollowing up on my note. Given {{signalShort}}, the number that tends to matter most at {{company}} is realized hours — {{proofPoint}}.\n\nHappy to share how, or to step back if the timing's wrong. Which is it?\n\n{{senderName}}",
    },
    {
      index: 2,
      label: "Break-up",
      dayOffset: 7,
      goal: "A short, respectful last touch that invites a reply or a clean opt-out.",
      guidance:
        "Keep it to three sentences. No new pitch. Make it easy to say 'not now' and easy to opt out. Stay grounded — no new claims.",
      fallbackTemplate:
        "Hi {{firstName}},\n\nI'll close the loop here so I'm not cluttering your inbox. If reclaiming billable hours at {{company}} becomes a priority, my door's open.\n\nEither way, wishing you a productive quarter.\n\n{{senderName}}",
    },
  ],
  complianceNotes: [
    "No guarantees of legal outcomes or case results.",
    "No unsolicited claims about the firm's clients or matters.",
    "US-only outreach; honor opt-outs immediately.",
  ],
};

export default LEGAL_PROMPTS;
