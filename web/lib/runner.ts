/**
 * Server-side access to the offline pipeline.
 *
 * The deployed site is replay-only and must stay that way: it serves committed
 * JSON and never calls a paid API at request time. Everything here exists for the
 * *local clone* case — you cloned the repo, put your keys in `.env`, and want to
 * reproduce the results without leaving the browser.
 *
 * Runs used to require `DOCRACE_ENABLE_RUNS=1`, which meant the honest answer to
 * "can I run this from the page?" was "no, restart your dev server first" — a flag
 * standing between a reader and the one thing the page is trying to provoke. The
 * flag is gone. What keeps a hosted copy safe was never the flag anyway; it is the
 * two gates below, both of which a serverless host fails on its own:
 *
 *   1. The pipeline venv must exist on disk at `pipeline/.venv`. A deployed build
 *      ships the web app, not a Python environment.
 *   2. A key must be present server-side. It is read from the environment or the
 *      repo's `.env` and never sent to the browser, never logged, and never
 *      echoed in a response.
 *
 * `DOCRACE_DISABLE_RUNS=1` remains as a kill switch, for the one deployment that
 * does have both — a repo checked out on a VM — where the gates would otherwise
 * pass and a stranger could spend your money.
 *
 * The money gates that remain are about *amount*, not permission: every scope is
 * priced server-side before it runs and refused above `MAX_RUN_USD`.
 *
 * There is deliberately no bring-your-own-key path. Accepting a visitor's key
 * over HTTP means owning the handling of somebody else's credential, and this
 * project does not need to.
 */

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

/** Repo root, from the web app's working directory. */
const REPO_ROOT = path.join(process.cwd(), "..");
const VENV_PYTHON = path.join(REPO_ROOT, "pipeline", ".venv", "bin", "python");

/**
 * Most a single UI-triggered run may be projected to cost, in USD.
 *
 * This used to be $5, from when a browser run was a two-question spot check. A run
 * is now a document against the approaches you picked, over the whole question set
 * — which is $15 on the smallest document and $46 on the 10-K with every approach
 * selected. At $5 the flow the page now offers would have been refused every time,
 * and a limit that blocks the documented path is not a safety feature, it is a bug
 * that reads as one.
 *
 * $25 is chosen against the actual projections rather than as a round number. Every
 * approach on the paper is $15 and on the contract $19, so the runs someone is
 * likely to want go through. Every approach on the 10-K is $46 and does not — the
 * single most expensive thing this UI can ask for needs a deliberate act, not a
 * click, and the refusal names the flag and prints the CLI equivalent.
 *
 * Set it high enough to admit that run and you get what a $50 ceiling got during
 * development: a $46 scope accepted as "under the limit" and started immediately.
 * The price in the confirm button is what stops a user overspending; this is what
 * stops the scope nobody meant to ask for, and it can only do that job if it sits
 * below the biggest thing on the menu.
 */
export const MAX_RUN_USD = (() => {
  const raw = Number(process.env.DOCRACE_MAX_RUN_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 25;
})();

export interface Capabilities {
  /** False only when `DOCRACE_DISABLE_RUNS=1` is set. */
  runsEnabled: boolean;
  pipelinePresent: boolean;
  keyPresent: boolean;
  /** Every gate passed; a run may be attempted. */
  canRun: boolean;
  maxRunUsd: number;
  /** Why runs are unavailable, phrased for display. Null when they are. */
  reason: string | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a key from the environment, falling back to the repo's `.env`.
 *
 * `next dev` loads `web/.env*` but not the repo-root `.env` the pipeline uses, and
 * asking someone to duplicate their keys into two files invites one copy going
 * stale. Only presence is ever reported outward — the value stays here.
 */
async function readKeyPresence(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  try {
    const raw = await readFile(path.join(REPO_ROOT, ".env"), "utf8");
    return /^\s*(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*=\s*\S+/m.test(raw);
  } catch {
    return false;
  }
}

export async function capabilities(): Promise<Capabilities> {
  const runsEnabled = process.env.DOCRACE_DISABLE_RUNS !== "1";
  const pipelinePresent = await exists(VENV_PYTHON);
  const keyPresent = await readKeyPresence();
  const canRun = runsEnabled && pipelinePresent && keyPresent;

  // Ordered so the reason a reader sees is the one they can act on first: an
  // explicit kill switch outranks a missing pipeline, which outranks a missing key
  // (there is no point telling someone to add a key to a clone that cannot run).
  let reason: string | null = null;
  if (!runsEnabled) {
    reason =
      "Runs are switched off on this instance by DOCRACE_DISABLE_RUNS=1. Unset it " +
      "and restart the dev server to run the pipeline from here.";
  } else if (!pipelinePresent) {
    reason =
      "No pipeline found at pipeline/.venv. Runs need the Python pipeline in a " +
      "local clone; a hosted copy of this site cannot run anything. Set it up with " +
      "cd pipeline && python3 -m venv .venv && .venv/bin/pip install -e .";
  } else if (!keyPresent) {
    reason =
      "No ANTHROPIC_API_KEY found in the environment or the repo's .env. " +
      "Copy .env.example to .env and fill it in.";
  }

  return { runsEnabled, pipelinePresent, keyPresent, canRun, maxRunUsd: MAX_RUN_USD, reason };
}

/** One line of the pipeline's structured progress stream. */
export interface PipelineEvent {
  event: string;
  [key: string]: unknown;
}

/**
 * A run: one document, the approaches you picked, every question.
 *
 * There is no question selection. A partial question set produces a partial
 * accuracy score, and the accuracy story is the whole point of the taxonomy — a
 * heatmap with three of five types filled in invites exactly the misreading the
 * page exists to prevent. Choosing the document and the approaches is the decision;
 * the questions are what a run *is*.
 */
export interface Scope {
  doc: string;
  arms: string[];
  /**
   * The model the arms answer with. Reaches the pipeline as `DOCRACE_MODEL` in
   * the subprocess environment rather than an argv flag, because the pipeline
   * binds the model into defaults at import time — see pricing.py. Indexing and
   * grading stay on their fixed models whatever this says.
   */
  model: string;
  /** Re-run cells that already have results. Maps to `precompute --force`. */
  force: boolean;
}

/**
 * Spawn a pipeline module and yield its stderr as parsed events.
 *
 * The pipeline writes one JSON object per line to stderr under `--json`, but
 * stderr also carries tracebacks, warnings, and our own actionable error
 * messages. Anything that does not parse is yielded as a `log` event rather than
 * dropped — swallowing the one line that explains a failure would be the worst
 * possible behaviour here.
 */
export async function* runPipeline(
  module: string,
  args: string[],
  signal?: AbortSignal,
  extraEnv?: Record<string, string>,
): AsyncGenerator<PipelineEvent> {
  // Test seam: point the precompute module at a stub that fakes the model, so the
  // route can be exercised end to end without spending anything. Only honoured
  // for the precompute module, and only when explicitly set.
  const stub = process.env.DOCRACE_PRECOMPUTE_STUB;
  const argv =
    stub && module === "docrace.precompute"
      ? ["-u", stub, ...args]
      : ["-u", "-m", module, ...args];

  const child = spawn(VENV_PYTHON, argv, {
    cwd: path.join(REPO_ROOT, "pipeline"),
    // The pipeline reads its own keys from the repo .env; only run parameters
    // (the model selection) are injected here, never credentials.
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });

  const queue: PipelineEvent[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const push = (e: PipelineEvent) => {
    queue.push(e);
    wake?.();
  };

  let buffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        push(JSON.parse(trimmed) as PipelineEvent);
      } catch {
        push({ event: "log", text: trimmed });
      }
    }
  });

  // stdout is the human-readable transcript. Forwarded as log lines so the panel
  // can show the same output the CLI would have printed.
  let outBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    outBuffer += chunk;
    const lines = outBuffer.split("\n");
    outBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) push({ event: "log", text: line });
    }
  });

  child.on("error", (err) => {
    push({ event: "run_error", error: err.message });
    done = true;
    wake?.();
  });
  child.on("close", (code) => {
    if (buffer.trim()) push({ event: "log", text: buffer.trim() });
    if (outBuffer.trim()) push({ event: "log", text: outBuffer.trim() });
    push({ event: "exit", code });
    done = true;
    wake?.();
  });

  try {
    while (!done || queue.length) {
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

export interface EstimateArm {
  arm: string;
  indexing_usd: number;
  per_query_usd: number;
  total_usd: number;
}

export interface Estimate {
  documents: {
    doc_id: string;
    tokens: number;
    questions: number;
    arms: EstimateArm[];
    grading_usd: number;
    total_usd: number;
  }[];
  total_usd: number;
  assumptions: string;
}

/**
 * Price a scope by asking the estimator.
 *
 * Deliberately a subprocess call rather than a TypeScript reimplementation: the
 * cost model has one home, `docrace/estimate.py`, and a second copy would drift
 * from it and quietly misprice the confirm dialog.
 */
export async function estimateScope(
  scope: Scope,
  questionCount: number,
): Promise<Estimate> {
  // The count is passed rather than left to the estimator's own default of 15. The
  // default is an assumption about questions.yaml; this is what the file actually
  // says, so a document with a shorter set is priced for the run it will get.
  const args = [
    "--json",
    "--doc",
    scope.doc,
    "--questions",
    String(questionCount),
    ...scope.arms.flatMap((a) => ["--arm", a]),
  ];
  let out = "";
  for await (const event of runPipeline("docrace.estimate", args, undefined, {
    DOCRACE_MODEL: scope.model,
  })) {
    if (event.event === "log") out += `${String(event.text)}\n`;
    if (event.event === "exit" && event.code !== 0) {
      throw new Error(`Estimator exited ${String(event.code)}: ${out.trim()}`);
    }
  }
  const start = out.indexOf("{");
  if (start === -1) throw new Error(`Estimator produced no JSON: ${out.trim()}`);
  return JSON.parse(out.slice(start)) as Estimate;
}
