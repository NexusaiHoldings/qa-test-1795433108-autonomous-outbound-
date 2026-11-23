"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { buildDb } from "@/lib/db";
import {
  connectMailbox,
  pauseMailbox,
  resumeMailbox,
  recheckMailboxDns,
  advanceWarmup,
  type MailboxProvider,
} from "@/lib/sdr/send-dispatcher";

interface Actor {
  userId: string;
  email: string;
  organizationId: string;
}

async function resolveActor(): Promise<Actor> {
  const user = await getSessionUser();
  if (!user?.id) {
    redirect("/mailbox?status=unauthorized");
  }
  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    redirect("/mailbox?status=no_org");
  }
  return { userId: user.id, email: user.email, organizationId };
}

/**
 * Look up the founder's connected OAuth account for a provider (via
 * @nexus/profile-and-account's connected_accounts). Returns the sending address
 * + the connected-account id so the mailbox links back to it.
 */
async function findConnectedAccount(
  userId: string,
  providers: string[],
): Promise<{ email: string; ref: string } | null> {
  const db = buildDb();
  const rows = await db.query<{ id: string; email: string | null }>(
    `SELECT id, email FROM connected_accounts
      WHERE user_id = $1 AND provider = ANY($2::text[]) AND email IS NOT NULL
      ORDER BY connected_at DESC
      LIMIT 1`,
    userId,
    providers,
  );
  const row = rows[0];
  if (!row || !row.email) return null;
  return { email: row.email, ref: row.id };
}

async function connect(provider: MailboxProvider, formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const providerAliases = provider === "outlook" ? ["microsoft", "azure-ad", "outlook"] : ["google", "gmail"];

  const connected = await findConnectedAccount(actor.userId, providerAliases);
  // Fall back to the founder's own session email if the OAuth connection has
  // not been wired yet (the extended-scope lego gap flagged in blockers).
  const email = (connected?.email || actor.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    redirect("/mailbox?status=connect_failed");
  }

  const physicalAddress = String(formData.get("physicalAddress") ?? "").trim() || null;

  try {
    await connectMailbox({
      organizationId: actor.organizationId,
      provider,
      email,
      displayName: null,
      connectedAccountRef: connected?.ref ?? null,
      physicalAddress,
    });
  } catch (err) {
    redirect(`/mailbox?status=connect_failed&reason=${encodeURIComponent(String((err as Error).message))}`);
  }

  revalidatePath("/mailbox");
  redirect("/mailbox?status=connected");
}

export async function connectGmailAction(formData: FormData): Promise<void> {
  await connect("gmail", formData);
}

export async function connectOutlookAction(formData: FormData): Promise<void> {
  await connect("outlook", formData);
}

export async function pauseMailboxAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const mailboxId = String(formData.get("mailboxId") ?? "").trim();
  if (!mailboxId) {
    redirect("/mailbox?status=missing_mailbox");
  }
  const reason = String(formData.get("reason") ?? "Paused by founder").trim() || "Paused by founder";
  await pauseMailbox(actor.organizationId, mailboxId, reason);
  revalidatePath("/mailbox");
  redirect("/mailbox?status=paused");
}

export async function resumeMailboxAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const mailboxId = String(formData.get("mailboxId") ?? "").trim();
  if (!mailboxId) {
    redirect("/mailbox?status=missing_mailbox");
  }
  await resumeMailbox(actor.organizationId, mailboxId);
  revalidatePath("/mailbox");
  redirect("/mailbox?status=resumed");
}

export async function recheckDnsAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const mailboxId = String(formData.get("mailboxId") ?? "").trim();
  if (!mailboxId) {
    redirect("/mailbox?status=missing_mailbox");
  }
  await recheckMailboxDns(actor.organizationId, mailboxId);
  revalidatePath("/mailbox");
  redirect("/mailbox?status=dns_rechecked");
}

export async function advanceWarmupAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const mailboxId = String(formData.get("mailboxId") ?? "").trim();
  if (!mailboxId) {
    redirect("/mailbox?status=missing_mailbox");
  }
  await advanceWarmup(actor.organizationId, mailboxId);
  revalidatePath("/mailbox");
  redirect("/mailbox?status=warmup_advanced");
}
