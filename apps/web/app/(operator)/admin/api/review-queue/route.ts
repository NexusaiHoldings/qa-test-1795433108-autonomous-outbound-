import { NextResponse } from "next/server";
import { getAdminUser } from "@nexus/admin-console";
import { listOpenReviewQueue } from "@/lib/sdr/review-resolution";

export async function GET(): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const items = await listOpenReviewQueue({
      id: String(admin.id),
      organizationId: String(admin.organizationId),
      email: admin.email ?? null,
    });
    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch review queue", detail: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    );
  }
}
