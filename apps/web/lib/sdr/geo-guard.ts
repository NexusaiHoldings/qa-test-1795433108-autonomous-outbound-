type ProspectLike = {
  country_code?: string | null;
  email?: string | null;
};

type SuppressionLike = {
  email?: string | null;
  domain?: string | null;
};

export function isSendable(prospect: ProspectLike, suppressions: SuppressionLike[]): boolean {
  const country = (prospect.country_code || "").trim().toUpperCase();
  if (country && country !== "US") {
    return false;
  }

  const email = (prospect.email || "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : "";

  for (const suppression of suppressions) {
    const suppressedEmail = (suppression.email || "").trim().toLowerCase();
    const suppressedDomain = (suppression.domain || "").trim().toLowerCase();

    if (suppressedEmail && email && suppressedEmail === email) {
      return false;
    }

    if (suppressedDomain && domain && suppressedDomain === domain) {
      return false;
    }
  }

  return true;
}
