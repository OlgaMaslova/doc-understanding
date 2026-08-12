/**
 * Replay a recorded race as Server-Sent Events.
 *
 * Every arm's answer was streamed once, offline, with each text fragment stamped
 * with its arrival time. This route replays every stream concurrently on
 * their original timings, so the race the visitor watches is the race that
 * actually happened — at zero marginal cost and with no API key involved.
 *
 * Wall-clock timings are compressed: agentic search genuinely takes a minute on
 * a 10-K, and a minute of staring is not a demo. The compression factor is sent
 * in the `start` event so the UI can say what it did rather than quietly
 * misrepresenting the latency.
 */

import { loadDoc } from "@/lib/results";
import type { ArmId, Cell } from "@/lib/types";
import { isFailed } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Longest a replay may take, before per-arm timings are scaled down to fit. */
const MAX_REPLAY_MS = 12_000;
/** Never slow a fast arm down; compression only ever speeds things up. */
const MIN_SPEEDUP = 1;

interface Scheduled {
  at: number;
  payload: Record<string, unknown>;
}

function schedule(cells: [ArmId, Cell][], speedup: number): Scheduled[] {
  const events: Scheduled[] = [];
  for (const [arm, cell] of cells) {
    events.push({ at: 0, payload: { type: "arm_start", arm } });
    for (const [ms, text] of cell.deltas) {
      events.push({ at: ms / speedup, payload: { type: "delta", arm, text } });
    }
    events.push({
      at: cell.latency_ms / speedup,
      payload: {
        type: "arm_done",
        arm,
        answer: cell.answer,
        latency_ms: cell.latency_ms,
        ttft_ms: cell.ttft_ms,
        cost: cell.cost,
        usage: cell.usage,
        grade: cell.grade,
        notes: cell.notes,
      },
    });
  }
  return events.sort((a, b) => a.at - b.at);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const docId = url.searchParams.get("doc");
  const questionId = url.searchParams.get("question");
  const instant = url.searchParams.get("instant") === "1";

  if (!docId || !questionId) {
    return new Response("doc and question are required", { status: 400 });
  }

  let doc;
  try {
    doc = await loadDoc(docId);
  } catch {
    return new Response(`Unknown document: ${docId}`, { status: 404 });
  }

  const cells: [ArmId, Cell][] = [];
  const failures: { arm: ArmId; error: string }[] = [];
  for (const [key, cell] of Object.entries(doc.cells)) {
    const [arm, qid] = key.split("::") as [ArmId, string];
    if (qid !== questionId) continue;
    if (isFailed(cell)) failures.push({ arm, error: cell.error });
    else cells.push([arm, cell]);
  }

  if (cells.length === 0 && failures.length === 0) {
    return new Response(`No recorded results for question ${questionId}`, {
      status: 404,
    });
  }

  const slowest = Math.max(...cells.map(([, c]) => c.latency_ms), 1);
  const speedup = instant
    ? Number.POSITIVE_INFINITY
    : Math.max(MIN_SPEEDUP, slowest / MAX_REPLAY_MS);
  const events = instant
    ? schedule(cells, 1).map((e) => ({ ...e, at: 0 }))
    : schedule(cells, speedup);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      // A client that navigates away mid-replay should stop the timers rather
      // than keep enqueueing into a dead stream.
      request.signal.addEventListener("abort", () => {
        closed = true;
      });

      send({
        type: "start",
        doc_id: docId,
        question_id: questionId,
        arms: cells.map(([arm]) => arm),
        failures,
        speedup: Number.isFinite(speedup) ? Number(speedup.toFixed(2)) : null,
        slowest_latency_ms: slowest,
      });

      let elapsed = 0;
      for (const event of events) {
        if (closed) break;
        const wait = event.at - elapsed;
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          elapsed = event.at;
        }
        send(event.payload);
      }

      send({ type: "end" });
      if (!closed) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and some proxies buffer SSE into uselessness without this.
      "X-Accel-Buffering": "no",
    },
  });
}
