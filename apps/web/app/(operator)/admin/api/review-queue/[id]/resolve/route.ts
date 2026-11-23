import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@nexus/admin-console";
import { resolveReviewQueueItem } from "@/lib/sdr/review-resolution";

type ResolveBody = {
  correctedClassification: string;
  action: "send_drafted_touch" | "close" | "suppress" | "hand_to_customer";
  notes?: string;
};

export async function POST(request: NextRequest, context: { params: { id: string } }): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as ResolveBody;
  if (!body?.correctedClassification || !body?.action) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  try {
    await resolveReviewQueueItem(
      {
        id: String(admin.id),
        organizationId: String(admin.organizationId),
        email: admin.email ?? null,
      },
      context.params.id,
      {
        correctedClassification: body.correctedClassification,
        action: body.action,
        notes: body.notes?.trim() ? body.notes.trim() : null,
      },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message.includes("already resolved")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to resolve review item", detail: message }, { status: 500 });
  }
}
