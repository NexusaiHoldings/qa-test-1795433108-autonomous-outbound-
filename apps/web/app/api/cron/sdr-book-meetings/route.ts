/**
 * /api/cron/sdr-book-meetings (F1-008)
 *
 * GET  — Vercel Cron entrypoint. Runs the booking loop across every org with
 *        pending work: (1) proposes three freebusy-clear slots to prospects who
 *        said yes (booking_requested), (2) books the meeting into the founder's
 *        Google Calendar with a Meet link when the prospect confirms a time (the
 *        classifier having extracted the datetime), sending a minimal templated
 *        confirmation, and (3) delivers the pre-meeting brief 12 hours before.
 * POST — scoped/manual trigger. Body { organizationId?, limit? } runs the loop
 *        for a single org (used by the /meetings "check now" control and tests).
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. When unset (local/dev) the route runs unguarded.
 */

import { NextResponse } from "next/server";
import { runBookMeetings } from "@/lib/sdr/booking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL + Buffer — not edge-compatible
export const maxDuration = 300;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod sets CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  try {
    const summary = await runBookMeetings({ nowMs: Date.now() });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "sdr.cron.book-meetings",
        event: "cron_failed",
        error: String((err as Error).message),
      }),
    );
    return NextResponse.json({ ok: false, error: String((err as Error).message) }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let body: { organizationId?: string; limit?: number };
  try {
    body = (await request.json()) as { organizationId?: string; limit?: number };
  } catch {
    body = {};
  }

  const organizationId = body.organizationId?.trim() || undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;

  try {
    const summary = await runBookMeetings({ nowMs: Date.now(), organizationId, limit });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message) }, { status: 500 });
  }
}
