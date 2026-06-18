import { getStore } from "@/lib/store";
import type { SessionSummary } from "trace-cli/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/stream — Server-Sent Events. Emits a `hello` event with the current session count, then one
 * `data:` frame per ingested/updated session (via the store's in-process `subscribe`), plus a 25s comment
 * keepalive. Tears down on client disconnect (`request.signal` abort) or stream cancel. Mirrors the old
 * collector SSE branch; `X-Accel-Buffering: no` (set in next.config headers) keeps proxies from buffering.
 */
export async function GET(request: Request) {
  const store = getStore();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const keepalive = setInterval(() => send(": keepalive\n\n"), 25_000);

      function send(frame: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          teardown();
        }
      }
      function teardown() {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
      }

      unsubscribe = store.subscribe((summary: SessionSummary) => send(`data: ${JSON.stringify(summary)}\n\n`));
      store
        .size()
        .then((count) => send(`event: hello\ndata: ${JSON.stringify({ count })}\n\n`))
        .catch(() => send(`event: hello\ndata: ${JSON.stringify({ count: null })}\n\n`));

      request.signal.addEventListener("abort", () => {
        teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
