"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ARM_COLOR, usd } from "@/lib/format";
import type { ArmId, Manifest } from "@/lib/types";

/**
 * Reproduce the results from the browser, in a local clone.
 *
 * This is the only control in the app that spends money, so it is built around
 * making the amount visible before anything happens: pick a scope, see what it
 * would cost, then confirm. The server re-prices and refuses anything above its
 * ceiling, so the number here is information rather than a security boundary.
 *
 * On a hosted copy every gate fails and this renders as an explanation of why —
 * which is more useful than hiding it, since "can I run this myself?" is the
 * question the whole page is trying to provoke.
 */

interface Caps {
  canRun: boolean;
  runsEnabled: boolean;
  pipelinePresent: boolean;
  keyPresent: boolean;
  maxRunUsd: number;
  maxLimit: number;
  reason: string | null;
}

interface Props {
  manifest: Manifest;
  docId: string;
  /** Called when a run finishes, so the page can pick up rewritten results. */
  onComplete: () => void;
}

type Phase = "idle" | "pricing" | "priced" | "running" | "done" | "error";

const DEFAULT_ARMS: ArmId[] = [
  "full_context",
  "cached_context_5m",
  "cached_context_1h",
];

export function RunPanel({ manifest, docId, onComplete }: Props) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [arms, setArms] = useState<ArmId[]>(DEFAULT_ARMS);
  const [limit, setLimit] = useState(2);
  const [phase, setPhase] = useState<Phase>("idle");
  const [projected, setProjected] = useState<number | null>(null);
  // Which scope the quote was for. Changing the scope must not leave a stale
  // price attached to a "spend and run" button, and comparing keys derives that
  // rather than resetting state from an effect.
  const [pricedFor, setPricedFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then(setCaps)
      .catch(() => setCaps(null));
  }, []);

  useEffect(() => {
    // Follow the tail while running, but never fight a reader who scrolled up.
    const el = logRef.current;
    if (!el || phase !== "running") return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [log, phase]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const scopeKey = `${docId}|${[...arms].sort().join(",")}|${limit}`;
  const quoteIsCurrent = pricedFor === scopeKey;

  const price = useCallback(async () => {
    setPhase("pricing");
    setMessage(null);
    try {
      const res = await fetch("/api/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: docId, arms, limit }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPhase("error");
        setMessage(data.error ?? "Could not price this scope.");
        return;
      }
      setProjected(data.total_usd);
      setPricedFor(scopeKey);
      setPhase("priced");
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Could not reach the server.");
    }
  }, [docId, arms, limit, scopeKey]);

  const run = useCallback(async () => {
    setPhase("running");
    setLog([]);
    setProgress(null);
    setMessage(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: docId, arms, limit }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setPhase("error");
        setMessage(data.error ?? `Run refused (${res.status}).`);
        return;
      }

      // SSE over POST, so this is read manually rather than with EventSource.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = 0;

      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));

          switch (event.event) {
            case "accepted":
              setProjected(event.projected_usd);
              break;
            case "doc_planned":
              setProgress({ done: 0, total: event.cells_pending });
              break;
            case "cell_done":
              done += 1;
              setProgress((p) => ({ done, total: p?.total ?? done }));
              setLog((l) => [
                ...l,
                `${event.arm} / ${event.question} — ${(event.latency_ms / 1000).toFixed(1)}s, ` +
                  `${usd(event.cost_usd)}, ${event.grade}` +
                  (event.cache_read_tokens
                    ? `, ${event.cache_read_tokens.toLocaleString()} tokens from cache`
                    : ""),
              ]);
              break;
            case "cell_error":
              done += 1;
              setLog((l) => [...l, `${event.arm} / ${event.question} — FAILED: ${event.error}`]);
              break;
            case "indexing_done":
              setLog((l) => [...l, `indexed ${event.arm} — ${usd(event.cost_usd)}`]);
              break;
            case "run_error":
              setMessage(String(event.error));
              break;
            case "log":
              setLog((l) => [...l, String(event.text)]);
              break;
            case "closed":
              break;
            default:
              break;
          }
        }
      }

      setPhase(message ? "error" : "done");
      onComplete();
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase("idle");
        setLog((l) => [...l, "Stopped. Finished cells were saved; resuming is free."]);
        onComplete();
        return;
      }
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Run failed.");
    } finally {
      abortRef.current = null;
    }
  }, [docId, arms, limit, message, onComplete]);

  if (!caps) return null;

  const toggleArm = (id: ArmId) =>
    setArms((current) =>
      current.includes(id) ? current.filter((a) => a !== id) : [...current, id],
    );

  const overCap = projected !== null && projected > caps.maxRunUsd;
  const showConfirm = phase === "priced" && quoteIsCurrent && !overCap;

  return (
    <section
      aria-labelledby="run-heading"
      className="space-y-4 rounded-md border border-border bg-bg-raised p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="run-heading" className="text-base font-medium text-text">
          Reproduce this yourself
        </h2>
        <p className="text-xs text-text-faint">
          Runs the real pipeline against your own API keys
        </p>
      </div>

      {!caps.canRun ? (
        <div className="space-y-2 text-sm leading-relaxed text-text-dim">
          <p>{caps.reason}</p>
          <p className="text-text-faint">
            Everything on this page was produced by the pipeline in this
            repository. Clone it, add your keys, and you can regenerate all of it —
            from the terminal, or from here with{" "}
            <code className="text-text-dim">DOCRACE_ENABLE_RUNS=1 npm run dev</code>.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">
                Arms
              </p>
              <div className="flex flex-wrap gap-1.5">
                {manifest.arms.map((arm) => {
                  const on = arms.includes(arm.id);
                  return (
                    <button
                      key={arm.id}
                      type="button"
                      onClick={() => toggleArm(arm.id)}
                      disabled={phase === "running"}
                      aria-pressed={on}
                      className={`rounded border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
                        on
                          ? "border-border-strong text-text"
                          : "border-border text-text-faint hover:text-text-dim"
                      }`}
                      style={on ? { borderColor: ARM_COLOR[arm.id] } : undefined}
                    >
                      {arm.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <label className="text-xs text-text-faint">
                <span className="mb-1.5 block uppercase tracking-wide">
                  Questions
                </span>
                <input
                  type="number"
                  min={1}
                  max={caps.maxLimit}
                  value={limit}
                  disabled={phase === "running"}
                  onChange={(e) =>
                    setLimit(
                      Math.max(
                        1,
                        Math.min(caps.maxLimit, Number(e.target.value) || 1),
                      ),
                    )
                  }
                  className="tnum w-20 rounded border border-border bg-bg-inset px-2 py-1 text-sm text-text disabled:opacity-40"
                />
              </label>
              <p className="max-w-md text-xs leading-relaxed text-text-faint">
                Use at least 2 — the cached arms need a second query before there is
                a cache to read, which is the thing worth verifying first.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {showConfirm ? (
              <button
                type="button"
                onClick={run}
                className="rounded border border-accent px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-inset"
              >
                Spend {projected !== null ? usd(projected) : ""} and run
              </button>
            ) : (
              <button
                type="button"
                onClick={price}
                disabled={
                  phase === "pricing" || phase === "running" || arms.length === 0
                }
                className="rounded border border-border-strong px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-inset disabled:opacity-40"
              >
                {phase === "pricing"
                  ? "Pricing…"
                  : projected !== null && !quoteIsCurrent
                    ? "Re-price this scope"
                    : "What would this cost?"}
              </button>
            )}

            {phase === "running" ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="rounded border border-border px-3 py-1.5 text-sm text-text-dim transition-colors hover:border-border-strong hover:text-text"
              >
                Stop
              </button>
            ) : null}

            {projected !== null && quoteIsCurrent && phase !== "running" ? (
              <p className="text-xs text-text-faint">
                Projected <span className="tnum text-text-dim">{usd(projected)}</span>
                {overCap
                  ? ` — above the ${usd(caps.maxRunUsd)} browser ceiling; run it from the terminal`
                  : ", give or take. Agentic search is the unpredictable one."}
              </p>
            ) : null}

            {progress ? (
              <p className="tnum text-xs text-text-faint">
                {progress.done}/{progress.total} cells
              </p>
            ) : null}
          </div>

          {message && (phase === "error" ? quoteIsCurrent || !projected : true) ? (
            <p className="whitespace-pre-wrap rounded border border-[#d1382a] bg-[#2a1210] px-3 py-2 text-sm leading-relaxed text-text">
              {message}
            </p>
          ) : null}

          {log.length ? (
            <div
              ref={logRef}
              className="max-h-56 overflow-y-auto rounded border border-border bg-bg-inset p-2 font-mono text-[11px] leading-relaxed text-text-dim"
            >
              {log.map((line, i) => (
                <p key={i} className="whitespace-pre-wrap break-all">
                  {line}
                </p>
              ))}
            </div>
          ) : null}

          {phase === "done" ? (
            <p className="text-sm text-text-dim">
              Done. The numbers above are now yours, not the ones this repository
              shipped with.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
