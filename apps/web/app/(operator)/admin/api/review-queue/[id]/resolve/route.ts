import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@nexus/organizations-and-teams";
import {
  resolveReview,
  type ReviewAction,
  type ReviewClassification,
} from "@/lib/sdr/review-resolution";

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

export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as {
    correctedClassification?: string;
    action?: string;
    notes?: string;
  };

  const correctedClassification = body.correctedClassification ?? "";
  const action = body.action ?? "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : null;

  if (!VALID_CLASSES.has(correctedClassification) || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const organizationId = String((admin as { organizationId?: string }).organizationId ?? "");
  const operatorId = String((admin as { userId?: string; id?: string }).userId ?? (admin as { id?: string }).id ?? "");
  if (!organizationId || !operatorId) {
    return NextResponse.json({ error: "admin_context_incomplete" }, { status: 400 });
  }

  try {
    await resolveReview({
      reviewId: context.params.id,
      organizationId,
      operatorId,
      correctedClassification: correctedClassification as ReviewClassification,
      action: action as ReviewAction,
      notes: notes && notes.length > 0 ? notes : null,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "resolve_failed";
    if (message === "review_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (message === "already_resolved") {
      return NextResponse.json({ error: "already_resolved" }, { status: 409 });
    }
    return NextResponse.json({ error: "resolve_failed" }, { status: 500 });
  }
}
