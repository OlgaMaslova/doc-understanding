"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ARM_COLOR, GRADE_COLOR, TYPE_ORDER, tokens, usd } from "@/lib/format";
import type { CatalogueDoc } from "@/lib/catalogue";
import type { Presets, PresetQuestion } from "@/lib/presets";
import type { ArmId, GradeId, QuestionType } from "@/lib/types";

/**
 * The run stage: measure a document with your own keys.
 *
 * This is the only control in the app that spends money, so it is built around
 * making the amount visible before anything happens: pick a document, pick the
 * approaches, see what it would cost, then confirm. The server re-prices and refuses
 * anything above its ceiling, so the number here is information rather than a
 * security boundary.
 *
 * There is no question picker. A run asks the whole set, because a partial set
 * produces a partial accuracy score and the taxonomy is the argument — a heatmap
 * with three of five types filled in invites the misreading the page exists to
 * prevent. Which document, and which approaches, is the decision worth offering.
 *
 * Every catalogued document is selectable, measured or not. Restricting this to
 * documents that already have results would refuse every first run, which is the
 * only kind of run a fresh clone has.
 */

interface Caps {
  canRun: boolean;
  runsEnabled: boolean;
  pipelinePresent: boolean;
  keyPresent: boolean;
  maxRunUsd: number;
  reason: string | null;
}

/** What a document's results currently look like, for the picker. */
export interface DocStatus {
  cells: number;
  cellsExpected: number;
  state: "measured" | "partial";
}

interface Props {
  /** Every fetched document, measured or not. */
  catalogue: CatalogueDoc[];
  /** Approach and question metadata that does not need a run to exist. */
  presets: Presets;
  /** Per-document completeness, for documents that have results. */
  status: Record<string, DocStatus>;
  /** Which document to start on — the one the results view was showing. */
  initialDocId?: string;
  /** Cell keys (`arm::question`) that already have results, by document. */
  measured: Record<string, string[]>;
  /** A run finished and rewrote results. */
  onComplete: (docId: string) => void;
  /**
   * A run changed results/ without finishing — failed or stopped. The data needs
   * re-fetching, but the reader stays here: the error (or the stop note) is the
   * thing they need to see, and navigating away would hide it.
   */
  onRefresh: () => void;
  /** Leave the run stage without running. */
  onBack: () => void;
}

type Phase = "idle" | "pricing" | "priced" | "running" | "done" | "error";

/** Live state of one arm x question cell during a run. */
type CellState =
  | { status: "skipped" }
  | { status: "queued" }
  | { status: "running" }
  | { status: "done"; grade: GradeId; costUsd: number; latencyMs: number }
  | { status: "failed"; error: string };

const DEFAULT_ARMS: ArmId[] = [
  "full_context",
  "cached_context_5m",
  "cached_context_1h",
];

const key = (arm: string, question: string) => `${arm}::${question}`;

/** The first clause of a type's rationale — what it demands, not what it exposes. */
function gloss(why: string): string {
  const [first] = why.split(/[.;]/);
  return first ? `${first.trim()}.` : why;
}

export function RunPanel({
  catalogue,
  presets,
  status,
  initialDocId,
  measured,
  onComplete,
  onRefresh,
  onBack,
}: Props) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [docId, setDocId] = useState(
    initialDocId ?? catalogue[0]?.doc_id ?? "",
  );
  const [arms, setArms] = useState<ArmId[]>(DEFAULT_ARMS);
  const [modelId, setModelId] = useState(
    () =>
      presets.models.find((m) => m.default)?.id ?? presets.models[0]?.id ?? "",
  );
  const [force, setForce] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [projected, setProjected] = useState<number | null>(null);
  // Which scope the quote was for. Changing the scope must not leave a stale price
  // attached to a "spend and run" button, and comparing keys derives that rather
  // than resetting state from an effect.
  const [pricedFor, setPricedFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [cellStates, setCellStates] = useState<Record<string, CellState>>({});
  /** Cells the pipeline said it would run, from `doc_planned`. */
  const [pendingTotal, setPendingTotal] = useState<number | null>(null);
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

  const questions: PresetQuestion[] = useMemo(
    () => presets.questions[docId] ?? [],
    [presets.questions, docId],
  );

  const byType = useMemo(() => {
    const groups = new Map<string, PresetQuestion[]>();
    for (const q of questions) {
      groups.set(q.type, [...(groups.get(q.type) ?? []), q]);
    }
    return groups;
  }, [questions]);

  const typeMeta = useMemo(
    () => new Map(presets.question_types.map((t) => [t.id, t])),
    [presets.question_types],
  );

  const doneCells = useMemo(
    () => new Set(measured[docId] ?? []),
    [measured, docId],
  );

  // Cells that already have results. The pipeline skips them unless forced, so they
  // are the difference between what a scope is priced at and what it spends.
  const alreadyDone = useMemo(() => {
    let n = 0;
    for (const arm of arms) {
      for (const q of questions) if (doneCells.has(key(arm, q.id))) n += 1;
    }
    return n;
  }, [arms, questions, doneCells]);

  const totalCells = arms.length * questions.length;
  const willRun = force ? totalCells : totalCells - alreadyDone;

  const model = presets.models.find((m) => m.id === modelId);
  const selectedDocMeta = catalogue.find((d) => d.doc_id === docId);
  // A document larger than the model's context cannot run the full-context or
  // cached approaches at all — those cells would fail one by one, after spending
  // on the ones before them. Said before pricing, not discovered mid-run.
  const overContext = Boolean(
    model?.context_window &&
      selectedDocMeta &&
      selectedDocMeta.tokens > model.context_window,
  );

  const scopeKey = `${docId}|${[...arms].sort().join(",")}|${modelId}|${force}`;
  const quoteIsCurrent = pricedFor === scopeKey;

  const body = useMemo(
    () => JSON.stringify({ doc: docId, arms, model: modelId, force }),
    [docId, arms, modelId, force],
  );

  const price = useCallback(async () => {
    setPhase("pricing");
    setMessage(null);
    try {
      const res = await fetch("/api/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
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
  }, [body, scopeKey]);

  const run = useCallback(async () => {
    setPhase("running");
    setLog([]);
    setMessage(null);
    setPendingTotal(null);
    // Seed the grid before the first result arrives, so it shows the shape of the
    // run rather than filling in from nothing. A cell that already has a result is
    // seeded as skipped, because the pipeline will not touch it: `doc_planned`
    // reports the selection and a pending *count*, never which cells are pending,
    // so seeding everything as queued would leave the skipped ones queued forever.
    setCellStates(
      Object.fromEntries(
        arms.flatMap((arm) =>
          questions.map((q) => [
            key(arm, q.id),
            {
              status: force || !doneCells.has(key(arm, q.id)) ? "queued" : "skipped",
            } as CellState,
          ]),
        ),
      ),
    );
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
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
      let failed = false;

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
              // The pipeline is the authority on how much work there is, so its
              // count drives the denominator even if our own skip arithmetic
              // disagreed — a progress bar that reads 3/4 and stops is worse than
              // one that was seeded slightly wrong.
              setPendingTotal(event.cells_pending as number);
              break;
            case "cell_start":
              setCellStates((prev) => ({
                ...prev,
                [key(event.arm, event.question)]: { status: "running" },
              }));
              break;
            case "cell_done":
              setCellStates((prev) => ({
                ...prev,
                [key(event.arm, event.question)]: {
                  status: "done",
                  grade: event.grade as GradeId,
                  costUsd: event.cost_usd,
                  latencyMs: event.latency_ms,
                },
              }));
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
              setCellStates((prev) => ({
                ...prev,
                [key(event.arm, event.question)]: {
                  status: "failed",
                  error: String(event.error),
                },
              }));
              setLog((l) => [
                ...l,
                `${event.arm} / ${event.question} — FAILED: ${event.error}`,
              ]);
              break;
            case "indexing_done":
              setLog((l) => [...l, `indexed ${event.arm} — ${usd(event.cost_usd)}`]);
              break;
            case "run_error":
              failed = true;
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

      if (failed) {
        // Stay on this panel so the error is readable. A failed run may still have
        // written cells before it died, so the data is refreshed in place.
        setPhase("error");
        onRefresh();
      } else {
        setPhase("done");
        onComplete(docId);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase("idle");
        setLog((l) => [...l, "Stopped. Finished cells were saved; resuming is free."]);
        onRefresh();
        return;
      }
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Run failed.");
    } finally {
      abortRef.current = null;
    }
  }, [arms, questions, body, docId, doneCells, force, onComplete, onRefresh]);

  const selectedDoc = catalogue.find((d) => d.doc_id === docId);
  const overCap =
    projected !== null && caps !== null && projected > caps.maxRunUsd;
  const showConfirm =
    phase === "priced" && quoteIsCurrent && !overCap && willRun > 0;
  const progress = Object.values(cellStates).filter(
    (c) => c.status === "done" || c.status === "failed",
  ).length;
  const progressTotal =
    pendingTotal ??
    Object.values(cellStates).filter((c) => c.status !== "skipped").length;
  const busy = phase === "running";

  return (
    <section aria-labelledby="run-heading" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="run-heading" className="text-base font-medium text-text">
            Run the evals
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-dim">
            Pick a document and the approaches to measure it with. Every question in
            the set is asked, every answer is graded against the answer key, and the
            results become the charts.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="text-sm text-text-faint underline decoration-dotted hover:text-text-dim disabled:opacity-40"
        >
          ← Back
        </button>
      </div>

      {caps && !caps.canRun ? (
        <div className="space-y-2 rounded-md border border-border bg-bg-raised p-4 text-sm leading-relaxed text-text-dim">
          <p>{caps.reason}</p>
          <p className="text-text-faint">
            Everything this page shows was produced by the pipeline in this
            repository. Clone it, add your keys, and you can regenerate all of it —
            from the terminal, or from here.
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-text-faint">Document</p>
        <div className="flex flex-wrap gap-2">
          {catalogue.map((d) => {
            const active = d.doc_id === docId;
            const st = status[d.doc_id];
            return (
              <button
                key={d.doc_id}
                type="button"
                onClick={() => setDocId(d.doc_id)}
                disabled={busy}
                aria-pressed={active}
                title={d.title}
                className={`rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                  active
                    ? "border-accent bg-bg-raised"
                    : "border-border bg-bg hover:border-border-strong"
                }`}
              >
                <span className="block text-sm text-text">{d.domain}</span>
                <span className="tnum block text-xs text-text-faint">
                  {tokens(d.tokens)} tokens
                </span>
                <span className="mt-1 block text-[11px] text-text-faint">
                  {!st ? (
                    "not run yet"
                  ) : st.state === "measured" ? (
                    <span className="text-text-dim">complete</span>
                  ) : (
                    <span className="text-[#d9a441]">
                      partial · {st.cells}/{st.cellsExpected}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {!catalogue.length ? (
          <p className="text-sm leading-relaxed text-text-dim">
            No documents have been fetched yet. Run{" "}
            <code className="text-text-dim">python -m docrace.documents</code> to
            fetch and normalize them — that part is free.
          </p>
        ) : null}
      </div>

      {presets.models.length ? (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-text-faint">Model</p>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={modelId}
              disabled={busy}
              onChange={(e) => setModelId(e.target.value)}
              aria-label="Model the approaches answer with"
              className="rounded border border-border bg-bg-inset px-2 py-1.5 text-sm text-text disabled:opacity-40"
            >
              {presets.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — ${m.input_per_mtok} in / ${m.output_per_mtok} out
                  per MTok
                </option>
              ))}
            </select>
            <p className="max-w-md text-xs leading-relaxed text-text-faint">
              The model every approach answers with. Indexing and grading stay on{" "}
              <span className="text-text-dim">{presets.index_model}</span> whichever
              you pick, so a run compares answering models, nothing else.
            </p>
          </div>
          {overContext && model?.context_window && selectedDocMeta ? (
            <p className="max-w-3xl rounded border border-[#d9a441] bg-[#2a2110] px-3 py-2 text-sm leading-relaxed text-text">
              {selectedDocMeta.domain} is {tokens(selectedDocMeta.tokens)} tokens,
              over {model.label}&apos;s {tokens(model.context_window)}-token context.
              The full-context and cached approaches cannot run on it — their cells
              will fail — and the retrieval approaches are the only fair test. Drop
              the full-context approaches or pick a larger-context model.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <p className="text-xs uppercase tracking-wide text-text-faint">
            Approaches
          </p>
          <div className="flex gap-x-3 text-xs">
            <button
              type="button"
              onClick={() => setArms(presets.arms.map((a) => a.id))}
              disabled={busy}
              className="text-text-faint underline decoration-dotted hover:text-text-dim disabled:opacity-40"
            >
              All {presets.arms.length}
            </button>
            <button
              type="button"
              onClick={() => setArms(DEFAULT_ARMS)}
              disabled={busy}
              className="text-text-faint underline decoration-dotted hover:text-text-dim disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {presets.arms.map((arm) => {
            const on = arms.includes(arm.id);
            return (
              <label
                key={arm.id}
                className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors ${
                  on
                    ? "border-border-strong bg-bg-raised"
                    : "border-border hover:border-border-strong"
                }`}
                style={on ? { borderColor: ARM_COLOR[arm.id] } : undefined}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy}
                  onChange={() =>
                    setArms((current) =>
                      current.includes(arm.id)
                        ? current.filter((a) => a !== arm.id)
                        : [...current, arm.id],
                    )
                  }
                  className="mt-0.5 shrink-0 accent-accent disabled:opacity-40"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-text">{arm.label}</span>
                  <span className="block text-xs leading-snug text-text-faint">
                    {arm.short}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Not a control — the questions are not a choice. Shown because a reader
          about to spend money should be able to see what is going to be asked, and
          because the taxonomy is the reason the whole set runs. */}
      {questions.length ? (
        <details className="rounded-md border border-border bg-bg-raised p-3">
          <summary className="cursor-pointer text-sm text-text-dim">
            All {questions.length} questions will be asked
            {selectedDoc ? ` of ${selectedDoc.domain}` : ""} — see them
          </summary>
          <div className="mt-3 space-y-3">
            {TYPE_ORDER.filter((t) => byType.has(t)).map((type) => {
              const meta = typeMeta.get(type as QuestionType);
              return (
                <div key={type}>
                  <p className="text-xs uppercase tracking-wide text-text-dim">
                    {meta?.label ?? type}
                    {meta ? (
                      <span
                        className="ml-2 normal-case tracking-normal text-text-faint"
                        title={meta.why}
                      >
                        {gloss(meta.why)}
                      </span>
                    ) : null}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {(byType.get(type) ?? []).map((q) => {
                      const done = arms.filter((a) =>
                        doneCells.has(key(a, q.id)),
                      ).length;
                      return (
                        <li key={q.id} className="text-sm leading-relaxed text-text-dim">
                          {q.question}
                          {done ? (
                            <span
                              className="ml-2 text-xs text-text-faint"
                              title="Already measured for these approaches. Skipped unless you tick re-run."
                            >
                              {done}/{arms.length} measured
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      <label className="flex items-center gap-2 text-xs text-text-dim">
        <input
          type="checkbox"
          checked={force}
          disabled={busy}
          onChange={(e) => setForce(e.target.checked)}
          className="accent-accent disabled:opacity-40"
        />
        Re-run cells that already have results
      </label>

      <div className="space-y-3 border-t border-border pt-4">
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
                phase === "pricing" ||
                busy ||
                arms.length === 0 ||
                !questions.length ||
                (caps !== null && !caps.canRun)
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

          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded border border-border px-3 py-1.5 text-sm text-text-dim transition-colors hover:border-border-strong hover:text-text"
            >
              Stop
            </button>
          ) : null}

          <p className="tnum text-xs text-text-faint">
            {busy
              ? `${progress}/${progressTotal} cells`
              : `${arms.length} approaches × ${questions.length} questions = ${totalCells} cells`}
            {!busy && !force && alreadyDone
              ? ` — ${alreadyDone} already measured, skipped`
              : ""}
          </p>
        </div>

        {projected !== null && quoteIsCurrent && !busy ? (
          <p className="max-w-3xl text-xs leading-relaxed text-text-faint">
            Projected <span className="tnum text-text-dim">{usd(projected)}</span>
            {overCap
              ? ` — above the ${usd(caps?.maxRunUsd ?? 0)} browser ceiling. Drop some approaches, or raise it with DOCRACE_MAX_RUN_USD.`
              : willRun < totalCells
                ? `, and that prices all ${totalCells} cells. ${totalCells - willRun} of them already have results and will be skipped, so the real spend is lower than this.`
                : ", give or take. Agentic search is the unpredictable one — its cost depends on how many searches each question provokes."}
          </p>
        ) : null}

        {willRun === 0 && !busy && questions.length ? (
          <p className="max-w-3xl text-xs leading-relaxed text-text-faint">
            Every cell in this scope has already been measured, so there is nothing to
            run and nothing to spend. Add an approach, pick another document, or tick
            re-run to measure them again.
          </p>
        ) : null}

        {message ? (
          <div
            role="alert"
            className="max-w-3xl rounded border border-[#d1382a] bg-[#2a1210] px-3 py-2 text-sm leading-relaxed text-text"
          >
            {phase === "error" ? (
              <p className="mb-1 font-medium text-[#f0857a]">Run failed</p>
            ) : null}
            <p className="whitespace-pre-wrap">{message}</p>
          </div>
        ) : null}

        {Object.keys(cellStates).length ? (
          <CellGrid
            arms={arms}
            questions={questions}
            states={cellStates}
            labels={new Map(presets.arms.map((a) => [a.id, a.label]))}
          />
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
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onComplete(docId)}
              className="rounded border border-accent px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-inset"
            >
              See the results →
            </button>
            <p className="text-sm text-text-dim">
              These numbers are yours now, not the ones this repository shipped with.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Live arm x question matrix for the run in progress.
 *
 * The log is a transcript and reads in the order things happened; this reads in the
 * shape of the run, which is what tells you at a glance that one approach is failing
 * every question rather than the run being slow. Grades are colour-coded to the same
 * scale as the heatmap, so a run producing wrong answers looks wrong while it is
 * still going.
 */
function CellGrid({
  arms,
  questions,
  states,
  labels,
}: {
  arms: ArmId[];
  questions: PresetQuestion[];
  states: Record<string, CellState>;
  labels: Map<ArmId, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs">
        <caption className="sr-only">
          Progress of each approach on each question
        </caption>
        <thead>
          <tr>
            <th className="p-1" />
            {arms.map((arm) => (
              <th key={arm} scope="col" className="p-1" title={labels.get(arm)}>
                <span
                  aria-hidden
                  className="mx-auto block h-2 w-2 rounded-full"
                  style={{ background: ARM_COLOR[arm] }}
                />
                <span className="sr-only">{labels.get(arm)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => (
            <tr key={q.id}>
              <th
                scope="row"
                className="max-w-md truncate p-1 text-left font-normal text-text-dim"
                title={q.question}
              >
                {q.question}
              </th>
              {arms.map((arm) => (
                <td key={arm} className="p-1 text-center">
                  <CellDot state={states[key(arm, q.id)]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellDot({ state }: { state: CellState | undefined }) {
  if (!state) return <span className="text-text-faint">·</span>;
  switch (state.status) {
    case "skipped":
      return (
        <span
          className="text-text-faint"
          title="Skipped — this cell already has a result. Tick re-run to measure it again."
        >
          ·
        </span>
      );
    case "queued":
      return (
        <span className="text-text-faint" title="Queued">
          ◦
        </span>
      );
    case "running":
      return (
        <span className="animate-pulse text-text" title="Running">
          ◍
        </span>
      );
    case "failed":
      return (
        <span style={{ color: GRADE_COLOR.hallucinated }} title={state.error}>
          ✗
        </span>
      );
    case "done":
      return (
        <span
          className="mx-auto block h-2.5 w-2.5 rounded-full"
          style={{ background: GRADE_COLOR[state.grade] }}
          title={`${state.grade} — ${usd(state.costUsd)}, ${(state.latencyMs / 1000).toFixed(1)}s`}
        />
      );
  }
}
