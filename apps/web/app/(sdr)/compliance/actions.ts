"use server";

import { upsertSuppression } from "@/lib/sdr/suppression";
import { getServerSession } from "@nexus/identity-and-access";

function getOrganizationId(session: unknown): string {
  const candidate = session as { organizationId?: string; user?: { organizationId?: string } };
  return candidate?.organizationId || candidate?.user?.organizationId || "";
}

export async function addSuppressionDomainAction(formData: FormData): Promise<void> {
  const session = await getServerSession();
  const organizationId = getOrganizationId(session);

  if (!organizationId) {
    throw new Error("Unauthorized");
  }

  const domain = String(formData.get("domain") || "").trim().toLowerCase();
  if (!domain) {
    throw new Error("Domain is required");
  }

  await upsertSuppression({
    organizationId,
    domain,
    reason: "manual",
  });
}

export async function uploadSuppressionCsvAction(formData: FormData): Promise<void> {
  const session = await getServerSession();
  const organizationId = getOrganizationId(session);
  if (!organizationId) {
    throw new Error("Unauthorized");
  }

  const text = String(formData.get("csv") || "");
  if (!text.trim()) {
    return;
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const [raw] = line.split(",");
    const value = raw.trim().toLowerCase();
    if (!value) continue;

    if (value.includes("@")) {
      await upsertSuppression({
        organizationId,
        email: value,
        reason: "customer_upload",
      });
    } else {
      await upsertSuppression({
        organizationId,
        domain: value.replace(/^@/, ""),
        reason: "customer_upload",
      });
    }
  }
}
