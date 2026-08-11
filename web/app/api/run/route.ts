/**
 * Run the real pipeline over a scope and stream its progress.
 *
 * The only endpoint in this app that spends money. Everything about it is built
 * so that spending is deliberate:
 *
 *   - Refused unless `DOCRACE_ENABLE_RUNS=1`, the pipeline is on disk, and a key
 *     is present. A hosted copy fails all three.
 *   - The scope is re-priced server-side and refused above `MAX_RUN_USD`. The
 *     client's own estimate is never trusted — it is a display value.
 *   - Progress streams as SSE so a run that takes minutes is legible rather than
 *     a spinner, and aborting the request kills the subprocess.
 *
 * The pipeline is resumable and writes after every cell, so an aborted run keeps
 * the cells it finished and costs nothing to resume.
 */

import { invalidate, loadManifest } from "@/lib/results";
import {
  capabilities,
  estimateScope,
  MAX_RUN_USD,
  runPipeline,
  type Scope,
} from "@/lib/runner";
import { isScopeError, parseScope } from "@/lib/scope";

export const dynamic = "force-dynamic";

function pipelineArgs(scope: Scope): string[] {
  return [
    "--json",
    "--doc",
    scope.doc,
    "--limit",
    String(scope.limit),
    ...scope.arms.flatMap((a) => ["--arm", a]),
  ];
}

export async function POST(request: Request) {
  const caps = await capabilities();
  if (!caps.canRun) {
    return Response.json({ error: caps.reason }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const manifest = await loadManifest();
  const scope = parseScope(
    body,
    manifest.docs.map((d) => d.doc_id),
  );
  if (isScopeError(scope)) {
    return Response.json({ error: scope.error }, { status: 400 });
  }

  // Re-price server-side. The client showed the user a number; this is the one
  // that decides, so a crafted request cannot exceed the ceiling.
  let projected: number;
  try {
    projected = (await estimateScope(scope)).total_usd;
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not price this scope." },
      { status: 500 },
    );
  }

  if (projected > MAX_RUN_USD) {
    const cli = [
      "cd pipeline && .venv/bin/python -m docrace.precompute",
      `--doc ${scope.doc}`,
      `--limit ${scope.limit}`,
      ...scope.arms.map((a) => `--arm ${a}`),
    ].join(" ");
    return Response.json(
      {
        error:
          `This scope is projected at $${projected.toFixed(2)}, above the ` +
          `$${MAX_RUN_USD.toFixed(2)} ceiling for runs started from the browser. ` +
          `Run it from the terminal instead, where the number is in front of you:` +
          `\n\n${cli}`,
        projected_usd: projected,
        max_run_usd: MAX_RUN_USD,
      },
      { status: 413 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ event: "accepted", scope, projected_usd: projected });

      try {
        for await (const event of runPipeline(
          "docrace.precompute",
          pipelineArgs(scope),
          request.signal,
        )) {
          send(event);
        }
      } catch (err) {
        send({
          event: "run_error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // A run rewrote results/, so the cached reads are now stale. Even an
        // aborted or failed run writes the cells it finished, which is why this
        // is in `finally` rather than on the success path.
        invalidate();
        // The page reloads its data on this, so it has to arrive even on failure —
        // a partial run still changed results/ and the UI must not show stale
        // numbers next to a finished log.
        send({ event: "closed" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
