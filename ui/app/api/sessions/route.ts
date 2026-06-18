import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

// DB-backed: never prerender, always run on the Node runtime (pg needs Node APIs).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/sessions — the compact session list (summaries) for the list view. */
export async function GET() {
  try {
    return NextResponse.json(await getStore().list());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/** DELETE /api/sessions — clear all sessions. */
export async function DELETE() {
  try {
    await getStore().clear();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
