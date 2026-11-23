import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import {
  resolveReview,
  type ReviewAction,
  type ReviewClassification,
} from "@/lib/sdr/review-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CLASSES: ReadonlySet<string> = new Set([
  "positive_interest",
  "not_interested",
  "objection",
  "unsubscribe",
  "out_of_office",
  "referral",
  "legal_threat",
]);

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "send_drafted_touch",
  "close",
  "suppress",
  "hand_to_customer",
]);

/**
 * Record an operator's decision on a review-queue item. Accepts either a JSON
 * body (API / fetch clients) or a classic form-urlencoded POST (the detail
 * page's resolve form); form submissions are redirected back to the queue so
 * the browser lands on a real page.
 *
 * Auth is enforced FIRST: a non-admin caller gets a 403 before the body is
 * parsed or any DB access occurs, per the F1-010 contract.
 */
export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const reviewId = context.params.id;
  const contentType = request.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  let correctedClassification = "";
  let action = "";
  let notes: string | null = null;

  if (isForm) {
    const form = await request.formData();
    correctedClassification = String(form.get("correctedClassification") ?? "");
    action = String(form.get("action") ?? "");
    const rawNotes = form.get("notes");
    notes = typeof rawNotes === "string" && rawNotes.trim().length > 0 ? rawNotes.trim() : null;
  } else {
    const body = (await request.json()) as {
      correctedClassification?: string;
      action?: string;
      notes?: string;
    };
    correctedClassification = body.correctedClassification ?? "";
    action = body.action ?? "";
    notes =
      typeof body.notes === "string" && body.notes.trim().length > 0 ? body.notes.trim() : null;
  }

  if (!VALID_CLASSES.has(correctedClassification) || !VALID_ACTIONS.has(action)) {
    if (isForm) {
      return NextResponse.redirect(
        new URL(`/admin/review-queue/${reviewId}?error=invalid_payload`, request.url),
        303,
      );
    }
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const organizationId = await getActiveOrganizationId(admin.id);
  const operatorId = admin.id;
  if (!organizationId || !operatorId) {
    if (isForm) {
      return NextResponse.redirect(
        new URL(`/admin/review-queue/${reviewId}?error=admin_context_incomplete`, request.url),
        303,
      );
    }
    return NextResponse.json({ error: "admin_context_incomplete" }, { status: 400 });
  }

  try {
    await resolveReview({
      reviewId,
      organizationId,
      operatorId,
      correctedClassification: correctedClassification as ReviewClassification,
      action: action as ReviewAction,
      notes,
    });

    if (isForm) {
      return NextResponse.redirect(new URL("/admin/review-queue?resolved=1", request.url), 303);
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "resolve_failed";
    if (isForm) {
      return NextResponse.redirect(
        new URL(`/admin/review-queue/${reviewId}?error=${encodeURIComponent(message)}`, request.url),
        303,
      );
    }
    if (message === "review_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (message === "already_resolved") {
      return NextResponse.json({ error: "already_resolved" }, { status: 409 });
    }
    return NextResponse.json({ error: "resolve_failed" }, { status: 500 });
  }
}
