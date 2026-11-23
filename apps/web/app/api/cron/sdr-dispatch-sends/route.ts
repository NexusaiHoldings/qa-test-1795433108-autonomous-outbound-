/**
 * /api/cron/sdr-dispatch-sends (F1-006)
 *
 * GET  — Vercel Cron entrypoint (every 15 minutes). Dispatches every due touch
 *        across all connected founder mailboxes within the prospect's business
 *        hours: re-checks suppression + geo + approval, verifies the address
 *        before touch 1, appends the CAN-SPAM footer + List-Unsubscribe headers,
 *        enforces the warmup ramp (20 → 40 → 80/day), and threads touches 2-3 as
 *        replies to touch 1.
 * POST — scoped/manual trigger. Body { organizationId?, limit? } dispatches for a
 *        single org (used by the /mailbox "send now" control and tests).
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. When unset (local/dev) the route runs unguarded.
 */

import { NextResponse } from "next/server";
import { dispatchDueSends } from "@/lib/sdr/send-dispatcher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL + node:dns — not edge-compatible
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
    const summary = await dispatchDueSends({ nowMs: Date.now() });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "sdr.cron.dispatch-sends",
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
    const summary = await dispatchDueSends({ nowMs: Date.now(), organizationId, limit });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message) }, { status: 500 });
  }
}
