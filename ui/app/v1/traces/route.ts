import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { Trace } from "trace-cli/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject envelopes larger than this (matches the old collector's ingress guard). */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * POST /v1/traces — ingest a trace envelope. Path is `/v1/traces` (NOT under `/api`) to match the wire
 * contract the CLI emits to (`Collector.emit` → `<url>/v1/traces`). The ingress boundary: hydrate untrusted
 * JSON into a Trace and enforce the envelope contract (`validate()`) before it touches the store. Reuses the
 * CLI's domain so validation + persistence are identical to a direct `trace … --emit` against the old collector.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return NextResponse.json({ error: "envelope too large" }, { status: 413 });

  let body: string;
  try {
    body = await request.text();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
  if (body.length > MAX_BYTES) return NextResponse.json({ error: "envelope too large" }, { status: 413 });

  try {
    const envelope = Trace.fromPlain(JSON.parse(body));
    const problems = envelope.validate();
    if (problems.length) return NextResponse.json({ error: "invalid envelope", problems }, { status: 400 });

    const summary = await getStore().ingest(envelope.toJSON());
    if (!summary) return NextResponse.json({ error: "envelope has no meta.sessionId" }, { status: 400 });

    return NextResponse.json({ ok: true, sessionId: summary.sessionId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
