"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArmCard, type ArmRunState } from "./ArmCard";
import { CostChart } from "./CostChart";
import { Heatmap } from "./Heatmap";
import { ARM_COLOR, seconds, tokens, usd } from "@/lib/format";
import type { CatalogueDoc } from "@/lib/catalogue";
import type { LeanDoc } from "@/lib/results";
import type { ArmId, Manifest, Question, QuestionType } from "@/lib/types";

interface Props {
  manifest: Manifest;
  docs: LeanDoc[];
  /** Every fetched document, so the picker can name the ones with no results. */
  catalogue: CatalogueDoc[];
  /** Open on this document — the one a run just produced. */
  initialDocId?: string;
  /** Go measure something. */
  onRunMore: () => void;
  /** Back to the fork. */
  onBack: () => void;
}

type States = Record<ArmId, ArmRunState>;

const IDLE: ArmRunState = { status: "waiting", text: "" };

function blankStates(arms: ArmId[]): States {
  return Object.fromEntries(arms.map((a) => [a, { ...IDLE }])) as States;
}

/**
 * The short half of a question type's rationale, for the picker.
 *
 * `why` is two clauses: what the type demands of an approach, then what it exposes
 * — "Requires seeing the whole document. Top-k retrieval structurally cannot." At
 * the point of picking a question the first clause is the one that says what you
 * are about to ask; the second is a finding, and it belongs with the heatmap that
 * demonstrates it. The full text stays on hover and in the methodology section.
 */
function gloss(why: string): string {
  const [first] = why.split(/[.;]/);
  return first ? `${first.trim()}.` : why;
}

/**
 * Split a trailing parenthetical off a value.
 *
 * The licence field carries its own audit trail — "CC BY 4.0 (verified on the arXiv
 * abstract page)" — because arXiv papers are not uniformly CC-licensed and the
 * check is worth recording. But the licence is the fact and the check is a
 * footnote, and running them together as one string reads as noise.
 */
function withoutNote(value: string): [string, string | null] {
  const match = value.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return match ? [match[1], match[2]] : [value, null];
}

/** One labelled field in the document card. */
function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs uppercase tracking-wide text-text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-text">{children}</dd>
    </div>
  );
}

export function ComparisonView({
  manifest,
  docs,
  catalogue,
  initialDocId,
  onRunMore,
  onBack,
}: Props) {
  const armIds = useMemo(() => manifest.arms.map((a) => a.id), [manifest.arms]);

  // Documents in the catalogue with nothing measured. They belong in the picker
  // named rather than absent: "there is one document" and "there are three, two of
  // which you have not run" are very different things to know, and only the second
  // tells a reader what the page is for.
  const pending = useMemo(
    () => catalogue.filter((c) => !docs.some((d) => d.doc_id === c.doc_id)),
    [catalogue, docs],
  );

  const [docId, setDocId] = useState(
    initialDocId && docs.some((d) => d.doc_id === initialDocId)
      ? initialDocId
      : docs[0].doc_id,
  );
  const doc = useMemo(
    () => docs.find((d) => d.doc_id === docId) ?? docs[0],
    [docs, docId],
  );

  const [selectedQuestionId, setSelectedQuestionId] = useState(
    doc.questions[0]?.id ?? "",
  );
  const [states, setStates] = useState<States>(() => blankStates(armIds));
  const [running, setRunning] = useState(false);
  const [speedup, setSpeedup] = useState<number | null>(null);
  const [finishOrder, setFinishOrder] = useState<ArmId[]>([]);

  const sourceRef = useRef<EventSource | null>(null);

  // Question ids are per-document, so a selection made on one document is
  // meaningless on another. Derive the effective id rather than syncing it in an
  // effect: the fallback is a pure function of the current document.
  const questionId = doc.questions.some((q) => q.id === selectedQuestionId)
    ? selectedQuestionId
    : (doc.questions[0]?.id ?? "");

  const stop = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => stop, [stop]);

  const compare = useCallback(
    (targetQuestionId: string, opts?: { instant?: boolean }) => {
      stop();
      setStates(blankStates(armIds));
      setFinishOrder([]);
      setSpeedup(null);
      setRunning(true);

      const params = new URLSearchParams({
        doc: docId,
        question: targetQuestionId,
      });
      if (opts?.instant) params.set("instant", "1");

      const source = new EventSource(`/api/comparison?${params}`);
      sourceRef.current = source;

      source.onmessage = (event) => {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        switch (msg.type) {
          case "start": {
            setSpeedup((msg.speedup as number | null) ?? null);
            const failures = (msg.failures ?? []) as {
              arm: ArmId;
              error: string;
            }[];
            if (failures.length) {
              setStates((prev) => {
                const next = { ...prev };
                for (const f of failures) {
                  next[f.arm] = { status: "failed", text: "", error: f.error };
                }
                return next;
              });
            }
            break;
          }
          case "arm_start": {
            const arm = msg.arm as ArmId;
            setStates((prev) => ({
              ...prev,
              [arm]: { ...prev[arm], status: "streaming", text: "" },
            }));
            break;
          }
          case "delta": {
            const arm = msg.arm as ArmId;
            const text = msg.text as string;
            setStates((prev) => ({
              ...prev,
              [arm]: { ...prev[arm], text: prev[arm].text + text },
            }));
            break;
          }
          case "arm_done": {
            const arm = msg.arm as ArmId;
            setStates((prev) => ({
              ...prev,
              [arm]: {
                status: "done",
                text: (msg.answer as string) || prev[arm].text,
                latency_ms: msg.latency_ms as number,
                ttft_ms: msg.ttft_ms as number,
                cost: msg.cost as ArmRunState["cost"],
                usage: msg.usage as ArmRunState["usage"],
                grade: msg.grade as ArmRunState["grade"],
                notes: msg.notes as Record<string, unknown>,
              },
            }));
            setFinishOrder((prev) => (prev.includes(arm) ? prev : [...prev, arm]));
            break;
          }
          case "end":
            stop();
            break;
        }
      };

      source.onerror = () => stop();
    },
    [armIds, docId, stop],
  );

  const question = doc.questions.find((q) => q.id === questionId);

  const byType = useMemo(() => {
    const groups = new Map<QuestionType, Question[]>();
    for (const q of doc.questions) {
      groups.set(q.type, [...(groups.get(q.type) ?? []), q]);
    }
    return groups;
  }, [doc.questions]);

  const cheapest = useMemo(() => {
    const entries = Object.entries(doc.economics) as [
      ArmId,
      NonNullable<LeanDoc["economics"][ArmId]>,
    ][];
    if (!entries.length) return null;
    return entries.reduce((a, b) =>
      a[1].marginal_cost_usd <= b[1].marginal_cost_usd ? a : b,
    );
  }, [doc.economics]);

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-text-faint underline decoration-dotted hover:text-text-dim"
        >
          ← Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-text-faint">
            Replayed from disk · nothing here calls an API
          </p>
          <button
            type="button"
            onClick={onRunMore}
            className="rounded border border-border-strong px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-inset"
          >
            Run the evals
          </button>
        </div>
      </div>

      {/* Document and question were one section behind a single screen-reader-only
          heading, which left the question picker looking like a caption on the
          document metadata above it. They are two separate choices, so they are two
          labelled sections. */}
      <section aria-labelledby="document-heading" className="space-y-3">
        <h2
          id="document-heading"
          className="text-base font-medium text-text"
        >
          Document
        </h2>

        <div className="flex flex-wrap gap-2">
          {docs.map((d) => {
            const active = d.doc_id === docId;
            return (
              <button
                key={d.doc_id}
                type="button"
                onClick={() => {
                  stop();
                  setDocId(d.doc_id);
                  setStates(blankStates(armIds));
                  setFinishOrder([]);
                }}
                aria-pressed={active}
                className={`rounded-md border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-accent bg-bg-raised"
                    : "border-border bg-bg hover:border-border-strong"
                }`}
              >
                <span className="block text-sm text-text">{d.domain}</span>
                <span className="tnum block text-xs text-text-faint">
                  {tokens(d.tokens)} tokens
                </span>
                {(() => {
                  // Which document you are looking at decides how much its
                  // numbers can carry, so completeness rides the selector.
                  const m = manifest.docs.find((x) => x.doc_id === d.doc_id);
                  if (!m || m.provenance_state === "measured") return null;
                  return (
                    <span className="mt-1 block text-[11px] text-[#d9a441]">
                      partial · {m.cells}/{m.cells_expected}
                    </span>
                  );
                })()}
              </button>
            );
          })}

          {/* Fetched, never measured. Dashed and unselectable, because a document
              with no cells has nothing to show — but leaving it out entirely is
              how the page ended up looking like a one-document tool. */}
          {pending.map((d) => (
            <div
              key={d.doc_id}
              className="rounded-md border border-dashed border-border px-3 py-2 text-left"
              title={d.title}
            >
              <span className="block text-sm text-text-faint">{d.domain}</span>
              <span className="tnum block text-xs text-text-faint">
                {tokens(d.tokens)} tokens
              </span>
              <span className="mt-1 block text-[11px] text-text-faint">
                not run yet
              </span>
            </div>
          ))}
        </div>

        {pending.length ? (
          <p className="text-sm text-text-dim">
            {pending.map((d, i) => (
              <span key={d.doc_id}>
                {i > 0 ? (i === pending.length - 1 ? " and " : ", ") : ""}
                <span className="text-text">{d.domain}</span>
              </span>
            ))}{" "}
            {pending.length === 1 ? "has" : "have"} been fetched but never
            measured, so {pending.length === 1 ? "it has" : "they have"} nothing to
            plot yet.{" "}
            <button
              type="button"
              onClick={onRunMore}
              className="text-text underline decoration-border-strong underline-offset-2 hover:decoration-accent"
            >
              Run {pending.length === 1 ? "it" : "one"}
            </button>{" "}
            and it joins these charts. Swapping documents is what moves the
            crossover, so a second one is where this page starts earning its
            argument.
          </p>
        ) : null}

        {(() => {
          const m = manifest.docs.find((x) => x.doc_id === doc.doc_id);
          if (!m || m.provenance_state === "measured") return null;
          return (
            <p className="text-sm leading-relaxed text-[#d9a441]">
              {m.cells} of {m.cells_expected} cells measured for this document.
              The charts and scores are real but computed from a partial matrix —
              treat them as a spot check, not a result.
            </p>
          );
        })()}

        {/* The document's identity as a labelled card rather than a run-on line of
            middot-separated values. Provenance and licence are the fields a reader
            has to be able to check — the page redistributes third-party text and
            asks to be believed about numbers measured on it — so they get names
            instead of being guessable from position. */}
        {(() => {
          const [license, licenseNote] = withoutNote(doc.license);
          return (
            <dl className="grid gap-x-6 gap-y-3 rounded-md border border-border bg-bg-raised p-4 sm:grid-cols-2">
              <Field label="Type">{doc.domain}</Field>
              <Field label="Size">
                <span className="tnum">{doc.tokens.toLocaleString()}</span> tokens
              </Field>
              <Field label="Title" className="sm:col-span-2">
                {doc.title}
              </Field>
              <Field label="Source">
                {doc.source_url ? (
                  <a
                    href={doc.source_url}
                    className="underline decoration-border-strong underline-offset-2 hover:decoration-accent"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {doc.provenance || "source"}
                  </a>
                ) : (
                  doc.provenance || "—"
                )}
              </Field>
              <Field label="License">
                {license}
                {licenseNote ? (
                  <span className="mt-0.5 block text-xs text-text-faint">
                    {licenseNote}
                  </span>
                ) : null}
              </Field>
            </dl>
          );
        })()}
      </section>

      <section aria-labelledby="question-heading" className="space-y-4">
        <div className="max-w-3xl">
          <h2 id="question-heading" className="text-base font-medium text-text">
            Pick a question
          </h2>
          <p className="mt-1.5 text-sm text-text-dim">
            {doc.questions.length} questions about this document, grouped by kind.
            The kind is what decides whether an approach can answer it at all,
            which is why they are grouped rather than listed. Clicking one runs the
            comparison.
          </p>
        </div>

        <div className="space-y-3">
          {manifest.question_types.map((qt) => {
            const group = byType.get(qt.id) ?? [];
            if (!group.length) return null;
            const labelId = `qtype-${qt.id}`;
            return (
              <div
                key={qt.id}
                role="group"
                aria-labelledby={labelId}
                className="flex flex-wrap gap-x-3 gap-y-1.5"
              >
                {/* The label and the questions are separate columns, and the
                    questions wrap inside their own. As siblings in one wrapping
                    row, a group's third question wrapped to the container's left
                    edge — underneath the label — so it read as belonging to no
                    group, or to the next one. */}
                <div className="w-40 shrink-0">
                  <p
                    id={labelId}
                    className="text-xs uppercase tracking-wide text-text-dim"
                  >
                    {qt.label}
                  </p>
                  {/* The type names are jargon, and this is where a reader meets
                      them — a tooltip is not an explanation. */}
                  <p className="text-xs text-text-faint">{gloss(qt.why)}</p>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                  {group.map((q) => {
                  const active = q.id === questionId;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => {
                        setSelectedQuestionId(q.id);
                        compare(q.id);
                      }}
                      aria-pressed={active}
                      className={`max-w-full truncate rounded border px-2 py-1 text-left text-xs transition-colors ${
                        active
                          ? "border-accent text-text"
                          : "border-border text-text-dim hover:border-border-strong hover:text-text"
                      }`}
                      title={q.question}
                    >
                      {q.question}
                    </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="comparison-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="comparison-heading" className="text-base font-medium text-text">
            {question ? question.question : "Pick a question"}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => questionId && compare(questionId)}
              disabled={!questionId}
              className="rounded border border-accent px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-raised disabled:opacity-40"
            >
              {running ? "Restart comparison" : "Run the comparison"}
            </button>
            <button
              type="button"
              onClick={() => questionId && compare(questionId, { instant: true })}
              disabled={!questionId}
              className="rounded border border-border px-3 py-1.5 text-sm text-text-dim transition-colors hover:border-border-strong hover:text-text disabled:opacity-40"
            >
              Skip to results
            </button>
          </div>
        </div>

        {speedup !== null && speedup > 1.05 ? (
          <p className="text-xs text-text-faint">
            Replaying recorded streams at{" "}
            <span className="tnum">{speedup.toFixed(1)}×</span> speed. The latency
            figures on each card are the real measured times.
          </p>
        ) : null}

        {/* The answer key, stated outright rather than behind a disclosure.
            Every grade on this page was assigned against this reference answer,
            and a tool whose whole argument is "don't take a blog post's word for
            it" cannot then ask the reader to take its grades on faith. It used to
            be a <details open>, which is a collapse affordance on the one thing
            that should never be collapsed — you cannot judge an answer without
            knowing the right one. The quote is verified verbatim against the
            document by check_questions.py, so the reader can check the reference
            too, not just the answers. */}
        {question ? (
          <div className="rounded-md border border-accent/40 bg-bg-raised px-4 py-3 text-sm">
            <h3 className="text-xs uppercase tracking-wide text-accent">
              Correct answer
            </h3>
            <p className="mt-0.5 text-xs text-text-faint">
              Committed with the question before any run. Every grade below is
              measured against this, not against the other answers.
            </p>

            <div className="mt-3 space-y-3 leading-relaxed">
              <p className="text-base text-text">{question.ground_truth}</p>

              {question.quote ? (
                <figure className="space-y-1">
                  <blockquote className="border-l-2 border-border-strong pl-3 text-text-dim">
                    “{question.quote}”
                  </blockquote>
                  <figcaption className="text-xs text-text-faint">
                    Verbatim from the document. Every quote in the answer key is
                    checked against the source text before a run.
                  </figcaption>
                </figure>
              ) : null}

              {question.absent_terms.length ? (
                <div className="space-y-1">
                  <p className="text-xs text-text-faint">
                    This answer is <strong className="text-text-dim">not</strong>{" "}
                    in the document. These phrases were each confirmed absent, so
                    any approach that produces a figure here invented it:
                  </p>
                  <p className="flex flex-wrap gap-1.5">
                    {question.absent_terms.map((t) => (
                      <code
                        key={t}
                        className="rounded bg-bg-inset px-1.5 py-0.5 text-xs text-text-dim"
                      >
                        {t}
                      </code>
                    ))}
                  </p>
                </div>
              ) : null}

              {question.grading_notes ? (
                <p className="text-xs text-text-faint">
                  <span className="text-text-dim">Grading notes:</span>{" "}
                  {question.grading_notes}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {manifest.arms.map((arm) => (
            <ArmCard
              key={arm.id}
              arm={arm}
              state={states[arm.id] ?? IDLE}
              place={
                finishOrder.indexOf(arm.id) >= 0
                  ? finishOrder.indexOf(arm.id) + 1
                  : undefined
              }
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="cost-heading" className="space-y-3">
        <div>
          <h2 id="cost-heading" className="text-base font-medium text-text">
            What it costs, as query volume grows
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-dim">
            Switch documents above and watch the lines reorder. Indexing and
            extraction are paid once, so they set where a line starts; the slope is
            what each additional query costs. On this document the cheapest
            marginal cost belongs to{" "}
            {cheapest ? (
              <>
                <span style={{ color: ARM_COLOR[cheapest[0]] }}>
                  {manifest.arms.find((a) => a.id === cheapest[0])?.label}
                </span>{" "}
                at <span className="tnum">{usd(cheapest[1].marginal_cost_usd)}</span>{" "}
                per query
              </>
            ) : (
              "no arm yet"
            )}
            .
          </p>
        </div>
        <CostChart economics={doc.economics} arms={manifest.arms} />
      </section>

      <section aria-labelledby="accuracy-heading" className="space-y-3">
        <div>
          <h2 id="accuracy-heading" className="text-base font-medium text-text">
            Where each approach breaks
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-dim">
            Cheap is only interesting if it is also right. Hover a cell for the
            grades behind it, or click one to compare a question of that type.
          </p>
        </div>
        <Heatmap
          arms={manifest.arms}
          questionTypes={manifest.question_types}
          questions={doc.questions}
          cells={doc.cells}
          credit={manifest.credit}
          onSelectQuestion={(id) => {
            setSelectedQuestionId(id);
            compare(id);
          }}
        />
      </section>

      <section aria-labelledby="detail-heading" className="space-y-3">
        <h2 id="detail-heading" className="text-base font-medium text-text">
          Per-approach summary for this document
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-text-dim">
                <th className="border-b border-border p-2 font-medium">Approach</th>
                <th className="border-b border-border p-2 font-medium">
                  Paid once
                </th>
                <th className="border-b border-border p-2 font-medium">
                  Per query
                </th>
                <th className="border-b border-border p-2 font-medium">
                  Median latency
                </th>
                <th className="border-b border-border p-2 font-medium">Score</th>
                <th className="border-b border-border p-2 font-medium">
                  Where it breaks
                </th>
              </tr>
            </thead>
            <tbody>
              {manifest.arms.map((arm) => {
                const e = doc.economics[arm.id];
                return (
                  <tr key={arm.id}>
                    <th
                      scope="row"
                      className="border-b border-border p-2 text-left font-normal"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="h-2 w-2 rounded-full"
                          style={{ background: ARM_COLOR[arm.id] }}
                        />
                        <span className="text-text">{arm.label}</span>
                      </span>
                    </th>
                    <td className="tnum border-b border-border p-2 text-text-dim">
                      {e ? usd(e.fixed_cost_usd) : "—"}
                      {/* For an arm whose cache is shared across queries, more
                          than one warm means the cache lapsed mid-run and the
                          real spend exceeded this intercept — which is exactly
                          what the 5-minute variant exists to show. Agentic
                          search also warms repeatedly, but one warm per question
                          is how it is supposed to work, so flagging it there
                          would cry wolf. */}
                      {e && e.cache_write_shared && e.cache_write_count > 1 ? (
                        <span
                          className="ml-1 text-[#d9a441]"
                          title={`The cache was warmed ${e.cache_write_count} times during this run, costing ${usd(e.cache_write_total_usd)} in total rather than the single warm this figure assumes.`}
                        >
                          ×{e.cache_write_count}
                        </span>
                      ) : null}
                    </td>
                    <td className="tnum border-b border-border p-2 text-text-dim">
                      {e ? usd(e.marginal_cost_usd) : "—"}
                    </td>
                    <td className="tnum border-b border-border p-2 text-text-dim">
                      {e ? seconds(e.median_latency_ms) : "—"}
                    </td>
                    <td className="tnum border-b border-border p-2 text-text-dim">
                      {e ? `${Math.round(e.score * 100)}%` : "—"}
                    </td>
                    <td className="border-b border-border p-2 text-text-faint">
                      {arm.breaks}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* The way back out. A reader who got this far and believes the charts is
          exactly the reader who should be offered the chance to disbelieve them. */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <button
          type="button"
          onClick={onRunMore}
          className="rounded border border-accent px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-inset"
        >
          Run this yourself
        </button>
        <p className="max-w-2xl text-sm leading-relaxed text-text-dim">
          Same pipeline, your keys, your numbers. Every figure above came out of it,
          and a run overwrites them with yours.
        </p>
      </div>
    </div>
  );
}
