import { NextResponse } from "next/server";
import { getAdminUser } from "@nexus/organizations-and-teams";
import { listOpenReviewQueue } from "@/lib/sdr/review-resolution";

export async function GET(): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const organizationId = String((admin as { organizationId?: string }).organizationId ?? "");
  if (!organizationId) {
    return NextResponse.json({ error: "organization_missing" }, { status: 400 });
  }

  const data = await listOpenReviewQueue(organizationId, 200);
  return NextResponse.json(data, { status: 200 });
}
