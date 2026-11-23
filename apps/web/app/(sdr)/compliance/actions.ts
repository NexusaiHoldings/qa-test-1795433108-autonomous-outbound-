"use server";

import { addSuppression, parseCsvEmails } from "@/lib/sdr/suppression";
import { getServerSession } from "@nexus/identity-and-access";
import { getActiveOrganizationContext } from "@nexus/organizations-and-teams";

export async function addDomainSuppressionAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return { ok: false, error: "Unauthorized" };
  }

  const org = await getActiveOrganizationContext({ userId: session.user.id });
  if (!org?.organizationId) {
    return { ok: false, error: "No active organization" };
  }

  const domainRaw = String(formData.get("domain") ?? "").trim();
  if (!domainRaw) {
    return { ok: false, error: "Domain is required" };
  }

  await addSuppression({
    organizationId: org.organizationId,
    domain: domainRaw,
    reason: "manual",
  });

  return { ok: true };
}

export async function uploadSuppressionCsvAction(formData: FormData): Promise<{ ok: boolean; added: number; error?: string }> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return { ok: false, added: 0, error: "Unauthorized" };
  }

  const org = await getActiveOrganizationContext({ userId: session.user.id });
  if (!org?.organizationId) {
    return { ok: false, added: 0, error: "No active organization" };
  }

  const text = String(formData.get("csv_text") ?? "");
  const emails = parseCsvEmails(text);
  let added = 0;

  for (const email of emails) {
    await addSuppression({
      organizationId: org.organizationId,
      email,
      reason: "customer_upload",
    });
    added += 1;
  }

  return { ok: true, added };
}
