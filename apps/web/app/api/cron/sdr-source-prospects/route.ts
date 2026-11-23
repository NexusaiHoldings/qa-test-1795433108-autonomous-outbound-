/**
 * /api/cron/sdr-source-prospects (F1-004)
 *
 * GET  — Vercel Cron entrypoint. Runs daily: sources NEW prospects for EVERY
 *        active campaign across all orgs (Apollo search → suppression/geo-guard
 *        → dedupe → store up to daily_target rows → attach trigger signals).
 * POST — immediate-on-save trigger. Body { organizationId, campaignId } sources
 *        that one campaign right away so "your first prospects land within 10
 *        minutes of saving a campaign" (visual brief / empty state).
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it (GET and POST). When unset (local/dev) the route runs
 * unguarded. NO LinkedIn scraping — sourcing goes through Apollo only.
 */

import { NextResponse } from "next/server";
import { sourceCampaigns } from "@/lib/sdr/sourcing";

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
    const results = await sourceCampaigns({ nowMs: nowMs() });
    const totals = results.reduce(
      (acc, r) => {
        acc.sourced += r.sourced;
        acc.scanned += r.scanned;
        acc.signalsAttached += r.signalsAttached;
        return acc;
      },
      { sourced: 0, scanned: 0, signalsAttached: 0 },
    );
    return NextResponse.json({
      ok: true,
      campaigns: results.length,
      ...totals,
      results,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "sdr.cron.source-prospects",
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

  let body: { organizationId?: string; campaignId?: string };
  try {
    body = (await request.json()) as { organizationId?: string; campaignId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const organizationId = body.organizationId?.trim();
  const campaignId = body.campaignId?.trim();
  if (!organizationId) {
    return NextResponse.json({ ok: false, error: "organizationId_required" }, { status: 400 });
  }

  try {
    const results = await sourceCampaigns({
      organizationId,
      campaignId: campaignId || undefined,
      nowMs: nowMs(),
    });
    return NextResponse.json({ ok: true, campaigns: results.length, results });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message) }, { status: 500 });
  }
}
