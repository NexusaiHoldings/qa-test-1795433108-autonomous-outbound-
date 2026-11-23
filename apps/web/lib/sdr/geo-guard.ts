import type { SuppressionRecord } from "@/lib/sdr/suppression";

export type ProspectLike = {
  email?: string | null;
  countryCode?: string | null;
};

export type SendableResult = {
  sendable: boolean;
  reason: "ok" | "non_us" | "suppressed_email" | "suppressed_domain" | "missing_email";
};

export function isSendable(prospect: ProspectLike, suppressions: SuppressionRecord[]): SendableResult {
  const email = (prospect.email ?? "").trim().toLowerCase();
  if (!email) {
    return { sendable: false, reason: "missing_email" };
  }

  const countryCode = (prospect.countryCode ?? "").trim().toUpperCase();
  if (countryCode && countryCode !== "US") {
    return { sendable: false, reason: "non_us" };
  }

  const domain = email.includes("@") ? email.split("@")[1] : "";
  const suppressedEmail = suppressions.some((s) => s.email?.toLowerCase() === email);
  if (suppressedEmail) {
    return { sendable: false, reason: "suppressed_email" };
  }

  const suppressedDomain = domain
    ? suppressions.some((s) => s.domain?.toLowerCase() === domain)
    : false;
  if (suppressedDomain) {
    return { sendable: false, reason: "suppressed_domain" };
  }

  return { sendable: true, reason: "ok" };
}
