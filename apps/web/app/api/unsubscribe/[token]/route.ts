import { NextRequest, NextResponse } from "next/server";
import { addSuppression, recordUnsubscribeEvent } from "@/lib/sdr/suppression";
import { verifyUnsubscribeToken } from "@/lib/sdr/unsubscribe-token";

function getClientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const [first] = forwarded.split(",");
    return first?.trim() ?? null;
  }
  return req.headers.get("x-real-ip");
}

export async function GET(req: NextRequest, context: { params: { token: string } }): Promise<NextResponse> {
  const token = context.params.token;
  const verification = verifyUnsubscribeToken(token);

  const ipAddress = getClientIp(req);
  const userAgent = req.headers.get("user-agent");

  await recordUnsubscribeEvent({
    tokenHash: verification.tokenHash,
    ipAddress,
    userAgent,
  });

  if (!verification.valid || !verification.payload) {
    return new NextResponse(
      "<html><body><main><h1>Unsubscribe link invalid</h1><p>This link is invalid or expired.</p></main></body></html>",
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  await addSuppression({
    organizationId: verification.payload.organizationId,
    email: verification.payload.email,
    reason: "unsubscribe_link",
    sourceMessageId: verification.payload.messageId ?? null,
  });

  return new NextResponse(
    "<html><body><main><h1>You’re unsubscribed</h1><p>We’ve added you to this sender’s suppression list immediately.</p></main></body></html>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
