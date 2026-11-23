"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/admin-auth";
import {
  addSuppression,
  getActiveOrganizationId,
  parseCsvEmails,
} from "@/lib/sdr/suppression";

async function resolveOrgOrRedirect(): Promise<string> {
  const user = await getSessionUser();
  if (!user?.id) {
    redirect("/compliance?status=unauthorized");
  }
  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    redirect("/compliance?status=no_org");
  }
  return organizationId;
}

export async function addDomainSuppressionAction(formData: FormData): Promise<void> {
  const organizationId = await resolveOrgOrRedirect();

  const domainRaw = String(formData.get("domain") ?? "").trim();
  if (!domainRaw) {
    redirect("/compliance?status=domain_required");
  }

  await addSuppression({
    organizationId,
    domain: domainRaw,
    reason: "manual",
  });

  revalidatePath("/compliance");
  redirect("/compliance?status=domain_added");
}

export async function uploadSuppressionCsvAction(formData: FormData): Promise<void> {
  const organizationId = await resolveOrgOrRedirect();

  // Accept either pasted CSV text or an uploaded CSV file. Files are uploaded
  // via @nexus/files-and-media in production; here we also decode the raw bytes
  // so the action works end-to-end without a storage round-trip.
  let text = String(formData.get("csv_text") ?? "");
  const file = formData.get("csv_file");
  if (!text && file && typeof file === "object" && "arrayBuffer" in file) {
    text = Buffer.from(await (file as Blob).arrayBuffer()).toString("utf8");
  }

  const emails = parseCsvEmails(text);
  let added = 0;
  for (const email of emails) {
    await addSuppression({
      organizationId,
      email,
      reason: "customer_upload",
    });
    added += 1;
  }

  revalidatePath("/compliance");
  redirect(`/compliance?status=csv_uploaded&added=${added}`);
}
