/**
 * /api/cron/sdr-generate-sequences (F1-005)
 *
 * GET  — Vercel Cron entrypoint. For every active campaign across all orgs, drafts
 *        a grounded 3-touch sequence for each newly-sourced prospect that carries
 *        trigger signals. Segments the founder has already approved send
 *        autonomously; the first batch of a new segment lands on /approvals.
 * POST — immediate-on-source trigger. Body { organizationId, campaignId? } generates
 *        sequences for that org/campaign right after prospects are sourced.
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it (GET and POST). When unset (local/dev) the route runs unguarded.
 */

import { NextResponse } from "next/server";
import { generateSequences } from "@/lib/sdr/sequence-generator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL — not edge-compatible
export const maxDuration = 300;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod sets CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

function nowMs(): number {
  return new Date().getTime();
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  try {
    const summary = await generateSequences({ nowMs: nowMs() });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "sdr.cron.generate-sequences",
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

  let body: { organizationId?: string; campaignId?: string; limitPerCampaign?: number };
  try {
    body = (await request.json()) as {
      organizationId?: string;
      campaignId?: string;
      limitPerCampaign?: number;
    };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const organizationId = body.organizationId?.trim();
  const campaignId = body.campaignId?.trim();
  if (!organizationId) {
    return NextResponse.json({ ok: false, error: "organizationId_required" }, { status: 400 });
  }

  try {
    const summary = await generateSequences({
      organizationId,
      campaignId: campaignId || undefined,
      limitPerCampaign: body.limitPerCampaign,
      nowMs: nowMs(),
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message) }, { status: 500 });
  }
}
