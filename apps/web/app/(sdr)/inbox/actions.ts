"use server";

/**
 * Server actions for the /inbox conversation surface (F1-007).
 *
 * - editScheduledTouchAction / cancelScheduledTouchAction let the founder edit or
 *   cancel the agent's planned next touch (a queued outbound sdr_messages row).
 * - resolveReviewAction clears a customer-scope escalation off the "needs you" lane.
 * - checkNowAction runs the ingest loop on demand for the active org.
 *
 * All actions resolve the caller + active org first, scope every write by
 * organization_id, and use parameterized queries only.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { buildDb } from "@/lib/db";
import { ingestReplies } from "@/lib/sdr/reply-ingest";

interface Actor {
  userId: string;
  email: string;
  organizationId: string;
}

async function resolveActor(): Promise<Actor> {
  const user = await getSessionUser();
  if (!user?.id) {
    redirect("/inbox?status=unauthorized");
  }
  const organizationId = await getActiveOrganizationId(user.id);
  if (!organizationId) {
    redirect("/inbox?status=no_org");
  }
  return { userId: user.id, email: user.email, organizationId };
}

/** Resolve the prospect (thread) a given queued message belongs to, for redirect. */
async function threadForMessage(organizationId: string, messageId: string): Promise<string | null> {
  const db = buildDb();
  const rows = await db.query<{ prospect_id: string | null }>(
    `SELECT prospect_id FROM sdr_messages
      WHERE organization_id = $1 AND id = $2 LIMIT 1`,
    organizationId,
    messageId,
  );
  return rows[0]?.prospect_id ?? null;
}

export async function editScheduledTouchAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const messageId = String(formData.get("messageId") ?? "").trim();
  if (!messageId) {
    redirect("/inbox?status=missing_message");
  }
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  const db = buildDb();
  // Only queued (not-yet-sent) outbound touches are editable.
  await db.execute(
    `UPDATE sdr_messages
        SET subject = $3, body_text = $4, updated_at = NOW()
      WHERE organization_id = $1 AND id = $2
        AND direction = 'outbound' AND status = 'queued'`,
    actor.organizationId,
    messageId,
    subject,
    body,
  );

  const prospectId = await threadForMessage(actor.organizationId, messageId);
  revalidatePath("/inbox");
  if (prospectId) {
    revalidatePath(`/inbox/${prospectId}`);
    redirect(`/inbox/${encodeURIComponent(prospectId)}?status=edited`);
  }
  redirect("/inbox?status=edited");
}

export async function cancelScheduledTouchAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const messageId = String(formData.get("messageId") ?? "").trim();
  if (!messageId) {
    redirect("/inbox?status=missing_message");
  }

  const prospectId = await threadForMessage(actor.organizationId, messageId);

  const db = buildDb();
  await db.execute(
    `UPDATE sdr_messages
        SET status = 'cancelled', next_send_at = NULL, last_error = 'cancelled_by_founder', updated_at = NOW()
      WHERE organization_id = $1 AND id = $2
        AND direction = 'outbound' AND status = 'queued'`,
    actor.organizationId,
    messageId,
  );

  revalidatePath("/inbox");
  if (prospectId) {
    revalidatePath(`/inbox/${prospectId}`);
    redirect(`/inbox/${encodeURIComponent(prospectId)}?status=cancelled`);
  }
  redirect("/inbox?status=cancelled");
}

export async function resolveReviewAction(formData: FormData): Promise<void> {
  const actor = await resolveActor();
  const reviewId = String(formData.get("reviewId") ?? "").trim();
  const prospectId = String(formData.get("prospectId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!reviewId) {
    redirect("/inbox?status=missing_review");
  }

  const db = buildDb();
  await db.execute(
    `UPDATE sdr_review_queue
        SET status = 'resolved', resolved_at = NOW(), resolved_by = $3, resolution_note = $4
      WHERE organization_id = $1 AND id = $2 AND status = 'open'`,
    actor.organizationId,
    reviewId,
    actor.userId,
    note,
  );
  // Mark the underlying reply as founder-handled.
  await db.execute(
    `UPDATE sdr_replies r
        SET handled_by = 'customer'
       FROM sdr_review_queue q
      WHERE q.id = $2 AND q.organization_id = $1 AND r.id = q.reply_id`,
    actor.organizationId,
    reviewId,
  );

  revalidatePath("/inbox");
  if (prospectId) {
    revalidatePath(`/inbox/${prospectId}`);
    redirect(`/inbox/${encodeURIComponent(prospectId)}?status=resolved`);
  }
  redirect("/inbox?status=resolved");
}

export async function checkNowAction(): Promise<void> {
  const actor = await resolveActor();
  try {
    await ingestReplies({ nowMs: Date.now(), organizationId: actor.organizationId });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "sdr.inbox.check-now",
        event: "ingest_failed",
        error: String((err as Error).message),
      }),
    );
  }
  revalidatePath("/inbox");
  redirect("/inbox?status=checked");
}
