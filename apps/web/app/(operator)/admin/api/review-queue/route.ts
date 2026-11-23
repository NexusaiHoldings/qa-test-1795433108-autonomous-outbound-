import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin-auth";
import { getActiveOrganizationId } from "@/lib/sdr/suppression";
import { listOpenReviewQueue } from "@/lib/sdr/review-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator review-queue listing. Gated by getAdminUser() — any non-admin
 * caller gets a 403 BEFORE any DB access, per the F1-010 contract.
 */
export async function GET(): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const organizationId = await getActiveOrganizationId(admin.id);
  if (!organizationId) {
    return NextResponse.json({ error: "organization_missing" }, { status: 400 });
  }

  const data = await listOpenReviewQueue(organizationId, 200);
  return NextResponse.json(data, { status: 200 });
}
