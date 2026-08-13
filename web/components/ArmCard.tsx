"use client";

import { useEffect, useRef } from "react";

import { ARM_COLOR, GRADE_COLOR, seconds, tokens, usd } from "@/lib/format";
import type { ArmId, CostBreakdown, GradeId, UsageBreakdown } from "@/lib/types";

export interface ArmRunState {
  /**
   * Four ways to have no answer, and they are not interchangeable:
   *
   * `waiting` — the recording has not arrived yet. `missing` — it is not in the
   * recording at all, because the run that produced it was scoped; a scoped run
   * leaves holes in the matrix, and a card that says "Loading…" forever is the wrong
   * way to show one. `failed` — the arm itself errored during the run, which is a
   * finding about the arm. `unavailable` — the recording exists and could not be
   * fetched, which is a fact about this page and says nothing about the arm.
   */
  status: "waiting" | "missing" | "done" | "failed" | "unavailable";
  text: string;
  latency_ms?: number;
  ttft_ms?: number;
  cost?: CostBreakdown;
  usage?: UsageBreakdown;
  grade?: { grade: GradeId; rationale: string };
  notes?: Record<string, unknown>;
  error?: string;
}

interface Props {
  arm: { id: ArmId; label: string; short: string; wins: string; breaks: string };
  state: ArmRunState;
  /** Rank among finished arms, 1-indexed. Only shown once an arm is done. */
  place?: number;
}

const GRADE_LABEL: Record<GradeId, string> = {
  correct: "correct",
  partial: "partial",
  incorrect: "incorrect",
  hallucinated: "hallucinated",
  correctly_refused: "correctly refused",
};

/**
 * How each arm's `notes` should read.
 *
 * When a retrieval arm gets an aggregation question wrong, "what did retrieval
 * actually return?" is the only question worth asking, and the answer is already
 * in the payload — it was just never displayed. Keys are renamed to something a
 * reader can parse and ordered so the diagnostic ones come first; anything not
 * listed still shows, under its raw key, rather than being silently dropped.
 */
const NOTE_LABEL: Record<string, string> = {
  // Diagnostics first — for a retrieval arm that got the answer wrong, which
  // chunks came back is the whole explanation.
  retrieval: "how it searched",
  retrieved_chunks: "chunks used",
  top_k: "top-k",
  fused_candidates: "candidates fused",
  fuse_k: "fused to",
  iterations: "tool iterations",
  tool_calls: "tool calls",
  hit_iteration_cap: "hit iteration cap",
  context: "context",
  cache_ttl: "cache lifetime",
  cache_hit: "read from cache",
  cache_written: "wrote cache",
  cache_read_tokens: "tokens read from cache",
  cache_breakpoints: "cache breakpoints",
  extraction_chars: "record size (chars)",
  truncated: "answer truncated",
};

const NOTE_ORDER = Object.keys(NOTE_LABEL);

function noteEntries(notes: Record<string, unknown>): [string, string][] {
  const rank = (k: string) => {
    const i = NOTE_ORDER.indexOf(k);
    return i === -1 ? NOTE_ORDER.length : i;
  };
  return Object.entries(notes)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, v]) => {
      const label = NOTE_LABEL[k] ?? k.replace(/_/g, " ");
      if (typeof v === "boolean") return [label, v ? "yes" : "no"];
      if (Array.isArray(v)) {
        // Tool-call logs are objects; a count is more use than a wall of JSON.
        if (v.length && typeof v[0] === "object") return [label, `${v.length}`];
        return [label, v.join(", ")];
      }
      if (typeof v === "object") return [label, JSON.stringify(v)];
      return [label, String(v)];
    });
}

export function ArmCard({ arm, state, place }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // A new answer scrolls its card back to the top. Answers differ in length by an
  // order of magnitude, and a card left mid-scroll from the previous question opens
  // on the middle of a sentence.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [state.text]);

  const color = ARM_COLOR[arm.id];
  const cacheRead = state.usage?.cache_read_tokens ?? 0;

  return (
    <article className="flex min-h-[19rem] flex-col rounded-lg border border-border bg-bg-raised">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2">
        <span
          aria-hidden
          className="mt-[6px] h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-text">{arm.label}</h3>
          <p className="truncate text-xs text-text-faint">{arm.short}</p>
        </div>
        {state.status === "done" && place ? (
          <span
            className="tnum shrink-0 rounded bg-bg-inset px-1.5 py-0.5 text-xs text-text-dim"
            title="Finish order in this comparison"
          >
            #{place}
          </span>
        ) : null}
      </header>

      <div
        ref={bodyRef}
        className="flex-1 overflow-y-auto px-3 py-2 text-[13px] leading-relaxed text-text-dim"
      >
        {state.status === "waiting" ? (
          <p className="text-text-faint">Loading the recorded answer…</p>
        ) : state.status === "missing" ? (
          <p className="text-text-faint">
            Nothing recorded for this approach on this question — the run that produced
            these results did not include the cell.
          </p>
        ) : state.status === "failed" ? (
          <p className="text-[#d1382a]">
            This arm failed on this question: {state.error}
          </p>
        ) : state.status === "unavailable" ? (
          <p className="text-text-faint">
            The recorded answers for this document could not be loaded. The grades and
            costs below were measured; only the answer text is missing.
          </p>
        ) : (
          <p className="whitespace-pre-wrap">{state.text}</p>
        )}
      </div>

      <footer className="border-t border-border px-3 py-2">
        <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
          <div>
            <dt className="text-text-faint">cost/query</dt>
            <dd className="tnum text-text">
              {state.cost ? usd(state.cost.total) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-text-faint">latency</dt>
            <dd className="tnum text-text">
              {state.latency_ms !== undefined ? seconds(state.latency_ms) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-text-faint">
              {state.usage && state.usage.calls > 1 ? "calls" : "tokens in"}
            </dt>
            <dd className="tnum text-text">
              {state.usage
                ? state.usage.calls > 1
                  ? state.usage.calls
                  : tokens(
                      state.usage.input_tokens +
                        state.usage.cache_read_tokens +
                        state.usage.cache_write_5m_tokens +
                        state.usage.cache_write_1h_tokens,
                    )
                : "—"}
            </dd>
          </div>
        </dl>

        {cacheRead > 0 ? (
          <p className="mt-1.5 text-[11px] text-text-faint">
            <span className="tnum">{tokens(cacheRead)}</span> tokens served from
            cache at a tenth of the input rate.
          </p>
        ) : null}

        {state.grade ? (
          <div className="mt-2 flex items-start gap-2">
            <span
              className="mt-[5px] h-2 w-2 shrink-0 rounded-sm"
              style={{ background: GRADE_COLOR[state.grade.grade] }}
            />
            <p className="text-[11px] leading-snug">
              <span className="text-text">
                {GRADE_LABEL[state.grade.grade]}
              </span>{" "}
              <span className="text-text-faint">{state.grade.rationale}</span>
            </p>
          </div>
        ) : null}

        {/* Collapsed by default — this is the "why did it answer that" layer, and
            it should be one click away without crowding the comparison. */}
        {state.notes && Object.keys(state.notes).length ? (
          <details className="mt-2 text-[11px]">
            <summary className="cursor-pointer text-text-faint marker:text-text-faint hover:text-text-dim">
              How it got there
            </summary>
            <dl className="mt-1.5 space-y-0.5">
              {noteEntries(state.notes).map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="shrink-0 text-text-faint">{label}</dt>
                  <dd className="tnum break-all text-text-dim">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </footer>
    </article>
  );
}
