/**
 * Server-side access to the offline pipeline.
 *
 * The deployed site is replay-only and must stay that way: it serves committed
 * JSON and never calls a paid API at request time. Everything here exists for the
 * *local clone* case — you cloned the repo, put your keys in `.env`, and want to
 * reproduce the results without leaving the browser.
 *
 * Three gates, all of which must pass before a single token is spent:
 *
 *   1. `DOCRACE_ENABLE_RUNS=1` must be set. Absent, runs are refused. A deployed
 *      instance therefore cannot run anything even if the rest of this file were
 *      somehow reachable — the failure mode is "button disabled", not "surprise
 *      invoice".
 *   2. The pipeline venv must exist on disk. On a serverless host it does not.
 *   3. A key must be present server-side. It is read from the environment and
 *      never sent to the browser, never logged, and never echoed in a response.
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
 * A stray click must not be able to start the full $71 matrix. Scopes above this
 * are refused with the CLI command to run instead — the ceiling constrains the
 * button, not the pipeline.
 */
export const MAX_RUN_USD = 5;

export interface Capabilities {
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
  const runsEnabled = process.env.DOCRACE_ENABLE_RUNS === "1";
  const pipelinePresent = await exists(VENV_PYTHON);
  const keyPresent = await readKeyPresence();
  const canRun = runsEnabled && pipelinePresent && keyPresent;

  let reason: string | null = null;
  if (!runsEnabled) {
    reason =
      "Runs are off. They are opt-in so a deployed copy of this site can never " +
      "spend anything: start the dev server with DOCRACE_ENABLE_RUNS=1 to enable them.";
  } else if (!pipelinePresent) {
    reason =
      "No pipeline found at pipeline/.venv. Runs need the Python pipeline in a " +
      "local clone; a hosted copy of this site cannot run anything.";
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

export interface Scope {
  doc: string;
  arms: string[];
  limit: number;
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
    // The pipeline reads its own keys from the repo .env; nothing is injected here.
    env: process.env,
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
export async function estimateScope(scope: Scope): Promise<Estimate> {
  const args = [
    "--json",
    "--doc",
    scope.doc,
    "--questions",
    String(scope.limit),
    ...scope.arms.flatMap((a) => ["--arm", a]),
  ];
  let out = "";
  for await (const event of runPipeline("docrace.estimate", args)) {
    if (event.event === "log") out += `${String(event.text)}\n`;
    if (event.event === "exit" && event.code !== 0) {
      throw new Error(`Estimator exited ${String(event.code)}: ${out.trim()}`);
    }
  }
  const start = out.indexOf("{");
  if (start === -1) throw new Error(`Estimator produced no JSON: ${out.trim()}`);
  return JSON.parse(out.slice(start)) as Estimate;
}
