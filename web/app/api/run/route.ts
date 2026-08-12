/**
 * Run the real pipeline over a scope and stream its progress.
 *
 * The only endpoint in this app that spends money. Everything about it is built
 * so that spending is deliberate:
 *
 *   - Refused unless the pipeline is on disk and a key is present. A hosted copy
 *     fails both, which is what makes this safe to leave on by default.
 *   - The scope is re-priced server-side and refused above `MAX_RUN_USD`. The
 *     client's own estimate is never trusted — it is a display value.
 *   - Progress streams as SSE so a run that takes minutes is legible rather than
 *     a spinner, and aborting the request kills the subprocess.
 *
 * The pipeline is resumable and writes after every cell, so an aborted run keeps
 * the cells it finished and costs nothing to resume.
 *
 * A run asks every question in the document's set — no `--question`, no `--limit`.
 * A scope is a document and a set of approaches; see `Scope` for why the questions
 * are not part of the choice.
 */

import { loadCatalogue } from "@/lib/catalogue";
import { loadPresets, questionCount } from "@/lib/presets";
import { invalidate } from "@/lib/results";
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
    ...scope.arms.flatMap((a) => ["--arm", a]),
    ...(scope.force ? ["--force"] : []),
  ];
}

/** The equivalent CLI invocation, for when the browser refuses a scope. */
function cliFor(scope: Scope): string {
  return [
    `cd pipeline && DOCRACE_MODEL=${scope.model} .venv/bin/python -m docrace.precompute`,
    `--doc ${scope.doc}`,
    ...scope.arms.map((a) => `--arm ${a}`),
    ...(scope.force ? ["--force"] : []),
  ].join(" ");
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

  const catalogue = await loadCatalogue();
  const presets = await loadPresets();
  const scope = parseScope(
    body,
    catalogue.map((d) => d.doc_id),
    presets.models.map((m) => m.id),
  );
  if (isScopeError(scope)) {
    return Response.json({ error: scope.error }, { status: 400 });
  }

  const questions = questionCount(presets, scope.doc);
  if (questions === 0) {
    return Response.json(
      {
        error:
          `No questions are defined for ${scope.doc} in data/questions.yaml, so ` +
          `there is nothing to ask it.`,
      },
      { status: 400 },
    );
  }

  // Re-price server-side. The client showed the user a number; this is the one
  // that decides, so a crafted request cannot exceed the ceiling.
  let projected: number;
  try {
    projected = (await estimateScope(scope, questions)).total_usd;
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not price this scope." },
      { status: 500 },
    );
  }

  if (projected > MAX_RUN_USD) {
    return Response.json(
      {
        error:
          `This scope is projected at $${projected.toFixed(2)}, above the ` +
          `$${MAX_RUN_USD.toFixed(2)} ceiling for runs started from the browser. ` +
          `Drop some approaches, raise the ceiling with DOCRACE_MAX_RUN_USD, or run ` +
          `it from the terminal, where the number is in front of you:` +
          `\n\n${cliFor(scope)}`,
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

      send({
        event: "accepted",
        scope,
        projected_usd: projected,
        questions,
      });

      try {
        for await (const event of runPipeline(
          "docrace.precompute",
          pipelineArgs(scope),
          request.signal,
          { DOCRACE_MODEL: scope.model },
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
