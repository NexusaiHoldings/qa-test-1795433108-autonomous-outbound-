import { NextRequest, NextResponse } from "next/server";
import { hashToken, verifyUnsubscribeToken } from "@/lib/sdr/unsubscribe-token";
import { recordUnsubscribeEvent, upsertSuppression } from "@/lib/sdr/suppression";

export async function GET(request: NextRequest, context: { params: { token: string } }): Promise<NextResponse> {
  const { token } = context.params;

  try {
    const payload = verifyUnsubscribeToken(token);
    const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const userAgent = request.headers.get("user-agent") ?? null;

    await recordUnsubscribeEvent({
      tokenHash: hashToken(token),
      ipAddress,
      userAgent,
    });

    await upsertSuppression({
      organizationId: payload.orgId,
      email: payload.email,
      reason: "unsubscribe_link",
      sourceMessageId: payload.messageId ?? null,
    });

    return new NextResponse(
      `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Unsubscribed</title></head><body><main><h1>You're unsubscribed</h1><p>You will not receive further outreach emails from this sender.</p></main></body></html>`,
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  } catch {
    return new NextResponse(
      `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Invalid link</title></head><body><main><h1>Unsubscribe link invalid or expired</h1><p>Please reply directly to the email and we will honor your request manually.</p></main></body></html>`,
      {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
}
