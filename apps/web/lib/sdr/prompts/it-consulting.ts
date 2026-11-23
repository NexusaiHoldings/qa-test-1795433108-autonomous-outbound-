/**
 * Vertical prompt library — IT CONSULTING (MSPs / IT services firms).
 *
 * The third of the three libraries ceo_briefing.data_findings[1] requires.
 * Consumed by apps/web/lib/sdr/sequence-generator.ts: `systemPrompt` + per-touch
 * `guidance` steer the gateway LLM, and the `fallbackTemplate` strings compose
 * grounded, cited copy deterministically when the gateway is unavailable.
 *
 * Recipient-specific claims MUST cite an sdr_prospect_signals row; this file only
 * supplies value framing and tone.
 */

import type { VerticalPromptLibrary } from "@/lib/sdr/sequence-generator";

export const IT_CONSULTING_PROMPTS: VerticalPromptLibrary = {
  key: "it-consulting",
  label: "IT Consulting",
  audience:
    "Founders, owners, and practice leads at US managed-service providers (MSPs) and boutique IT consultancies.",
  systemPrompt: [
    "You are an SDR for an advisory that helps IT services firms productize and scale their delivery.",
    "Your reader is technical, pragmatic, and will spot hand-wavy claims instantly.",
    "Be specific about the operational pain and the mechanism of improvement.",
    "Never invent facts about the reader's company — only use supplied signals.",
    "One concrete ask per email.",
  ].join(" "),
  valueProps: [
    "turn one-off project work into recurring, higher-margin managed services",
    "standardize delivery so senior engineers stop firefighting",
    "scale headcount output without scaling headcount cost",
  ],
  painPoints: [
    "margin compression on project-based work",
    "senior engineers stuck in reactive break-fix instead of delivery",
    "growth stalling because delivery doesn't scale past the founders",
  ],
  proofPoints: [
    "an MSP lifted gross margin ~12 points by productizing delivery",
    "a 30-person firm doubled throughput without new senior hires",
    "recurring revenue mix grew from 35% to 60% in two quarters",
  ],
  subjectPatterns: [
    "{{company}} + recurring margin",
    "Scaling delivery at {{company}}",
    "{{firstName}} — noticed {{signalShort}}",
  ],
  touches: [
    {
      index: 0,
      label: "Intro email",
      dayOffset: 0,
      goal: "Open with a grounded signal tied to an operational scaling pain.",
      guidance:
        "Lead with the strongest signal as an observation. Tie it to one scaling/margin pain. Ask one low-friction question. No pitch deck energy.",
      fallbackTemplate:
        "Hi {{firstName}},\n\n{{signalSentence}} That stage is usually where {{painPoint}} shows up for an IT firm.\n\nWe help teams {{valueProp}} — {{proofPoint}}. Worth a quick reply if that's live for {{company}}?\n\nBest,\n{{senderName}}",
    },
    {
      index: 1,
      label: "Value follow-up",
      dayOffset: 3,
      goal: "Add one concrete proof point tied to the signal.",
      guidance:
        "Reference the first email briefly. Add one proof point relevant to the signal. Under 90 words. Re-ask, rephrased.",
      fallbackTemplate:
        "Hi {{firstName}},\n\nCircling back. With {{signalShort}}, the lever most firms like {{company}} pull first is delivery standardization — {{proofPoint}}.\n\nHappy to show the playbook, or to hold off if the timing's off. Which is it?\n\n{{senderName}}",
    },
    {
      index: 2,
      label: "Break-up",
      dayOffset: 7,
      goal: "Short, respectful last touch inviting a reply or clean opt-out.",
      guidance:
        "Three sentences max, no new claims, easy opt-out.",
      fallbackTemplate:
        "Hi {{firstName}},\n\nI'll close this out so I'm not crowding your inbox. If scaling delivery at {{company}} moves up the list, reply any time.\n\nWishing you a strong quarter.\n\n{{senderName}}",
    },
  ],
  complianceNotes: [
    "No guarantees of specific uptime, savings, or security outcomes.",
    "No claims about the firm's specific clients.",
    "US-only outreach; honor opt-outs immediately.",
  ],
};

export default IT_CONSULTING_PROMPTS;
