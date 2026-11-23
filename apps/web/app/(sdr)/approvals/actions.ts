"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import {
  approveSequence,
  approveSegment,
  skipSequence,
  isAupAcknowledged,
  type TouchEdit,
} from "@/lib/sdr/sequence-generator";

interface Actor {
  userId: string;
  email: string;
  organizationId: string;
}

async function resolveActor(): Promise<Actor> {
  const user = await getSessionUser();
  if (!user?.id) {
    redirect("/approvals?status=unauthorized");
  }
  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    redirect("/approvals?status=no_org");
  }
  return { userId: user.id, email: user.email, organizationId };
}

/** Collect the (up to three) inline-edited touches out of the submitted form. */
function collectEdits(formData: FormData): TouchEdit[] {
  const edits: TouchEdit[] = [];
  for (let i = 0; i < 3; i += 1) {
    const messageId = String(formData.get(`msgid_${i}`) ?? "").trim();
    if (!messageId) continue;
    const subject = String(formData.get(`subject_${i}`) ?? "");
    const body = String(formData.get(`body_${i}`) ?? "");
    edits.push({ messageId, subject, body });
  }
  return edits;
}

function selectParam(sequenceId: string): string {
  return sequenceId ? `&seq=${encodeURIComponent(sequenceId)}` : "";
}

export async function approveSequenceAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();

  const sequenceId = String(formData.get("sequenceId") ?? "").trim();
  if (!sequenceId) {
    redirect("/approvals?status=missing_sequence");
  }

  // Human-in-the-loop gate: AUP must be acknowledged before any first send.
  const acknowledged = await isAupAcknowledged(actor.userId);
  if (!acknowledged) {
    redirect(`/approvals?status=aup_required${selectParam(sequenceId)}`);
  }

  const result = await approveSequence({
    organizationId: actor.organizationId,
    approverId: actor.userId,
    approverEmail: actor.email,
    sequenceId,
    edits: collectEdits(formData),
  });

  revalidatePath("/approvals");
  if (!result.ok) {
    redirect(`/approvals?status=approve_failed&reason=${encodeURIComponent(result.error ?? "")}`);
  }
  const status = result.unlocked ? "segment_unlocked" : "approved";
  redirect(`/approvals?status=${status}&approved=${result.approved}`);
}

export async function approveSegmentAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();

  const campaignId = String(formData.get("campaignId") ?? "").trim();
  const segmentKey = String(formData.get("segmentKey") ?? "").trim();
  if (!campaignId || !segmentKey) {
    redirect("/approvals?status=missing_segment");
  }

  const acknowledged = await isAupAcknowledged(actor.userId);
  if (!acknowledged) {
    redirect("/approvals?status=aup_required");
  }

  const result = await approveSegment({
    organizationId: actor.organizationId,
    approverId: actor.userId,
    approverEmail: actor.email,
    campaignId,
    segmentKey,
  });

  revalidatePath("/approvals");
  if (!result.ok) {
    redirect(`/approvals?status=approve_failed&reason=${encodeURIComponent(result.error ?? "")}`);
  }
  redirect("/approvals?status=segment_unlocked");
}

export async function skipSequenceAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();

  const sequenceId = String(formData.get("sequenceId") ?? "").trim();
  if (!sequenceId) {
    redirect("/approvals?status=missing_sequence");
  }

  await skipSequence(actor.organizationId, sequenceId);
  revalidatePath("/approvals");
  redirect("/approvals?status=skipped");
}
