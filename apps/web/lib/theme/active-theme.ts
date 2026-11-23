/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#0f1a2e",
    "accent": "#1f4fd8",
    "border": "#d9dfeb",
    "danger": "#b3261e",
    "success": "#1b7a4a",
    "surface": "#f5f7fb",
    "textMuted": "#4f5b73",
    "accentText": "#ffffff",
    "surfaceAlt": "#eaeef6",
    "borderStrong": "#b7c1d4"
  },
  "shape": {
    "radius": 6
  }
};
