/**
 * /api/cron/sdr-ingest-replies (F1-007)
 *
 * GET  — Vercel Cron entrypoint (every 5 minutes). Polls each connected founder
 *        mailbox's recent Gmail, matches inbound messages to sdr_messages threads,
 *        writes sdr_replies (classification + confidence + extracted_datetime +
 *        handled_by), and runs the conversation policy (hand to booking / draft a
 *        grounded follow-up / reschedule / close / suppress / escalate to review).
 * POST — scoped/manual trigger. Body { organizationId?, limit? } ingests for a
 *        single org (used by the /inbox "check now" control and tests).
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. When unset (local/dev) the route runs unguarded.
 */

import { NextResponse } from "next/server";
import { ingestReplies } from "@/lib/sdr/reply-ingest";

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
    const summary = await ingestReplies({ nowMs: Date.now() });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "sdr.cron.ingest-replies",
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
    const summary = await ingestReplies({ nowMs: Date.now(), organizationId, limit });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message) }, { status: 500 });
  }
}
