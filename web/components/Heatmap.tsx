"use client";

import { useId, useState } from "react";

import { GRADE_COLOR, TYPE_ORDER, percent } from "@/lib/format";
import type { ArmId, GradeId, Manifest, Question, QuestionType } from "@/lib/types";
import type { LeanCell } from "@/lib/results";

/**
 * Accuracy by approach and question type.
 *
 * This is where the third finding lives: retrieval fails least often on the
 * questions people test it with and most often on the ones they ship. The needle
 * column is a wall of green for everybody, which is exactly why nobody notices
 * the problem — and then aggregation and absence go dark for the retrieval arms,
 * because top-k always returns something and something is what gets
 * hallucinated from.
 */

interface Props {
  arms: Manifest["arms"];
  questionTypes: Manifest["question_types"];
  questions: Question[];
  cells: Record<string, LeanCell>;
  credit: Record<GradeId, number>;
  onSelectQuestion?: (questionId: string) => void;
}

interface CellSummary {
  score: number;
  grades: { questionId: string; grade: GradeId; rationale: string }[];
}

function summarize(
  arm: ArmId,
  type: QuestionType,
  questions: Question[],
  cells: Record<string, LeanCell>,
  credit: Record<GradeId, number>,
): CellSummary | null {
  const grades: CellSummary["grades"] = [];
  let sum = 0;
  for (const q of questions) {
    if (q.type !== type) continue;
    const cell = cells[`${arm}::${q.id}`];
    if (!cell || "error" in cell) continue;
    const grade = cell.grade as GradeId;
    grades.push({ questionId: q.id, grade, rationale: cell.rationale });
    sum += credit[grade] ?? 0;
  }
  if (grades.length === 0) return null;
  return { score: sum / grades.length, grades };
}

/** Interpolate between a muted failure red and the pass green by score. */
const FAIL_RGB = [0.55, 0.18, 0.15];
const PASS_RGB = [0.25, 0.66, 0.48];

function scoreMix(score: number): number[] {
  return FAIL_RGB.map((f, i) => f + (PASS_RGB[i] - f) * score);
}

function scoreColor(score: number): string {
  const to255 = (v: number) => Math.round(v * 255);
  const mix = scoreMix(score);
  return `rgb(${to255(mix[0])} ${to255(mix[1])} ${to255(mix[2])})`;
}

/**
 * Ink for a cell's percentage, chosen against that cell's own fill.
 *
 * White was hardcoded, which is right at the failing end (8.3:1 on the red) and
 * wrong at the passing end: on a full-credit green it falls to 3.0:1, so the
 * cells a reader most wants to read were the least readable ones. Deriving the
 * ink from relative luminance rather than a score threshold means it stays
 * correct if the scale is ever retuned.
 */
function scoreInk(score: number): string {
  const [r, g, b] = scoreMix(score);
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const luminance =
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const onWhite = 1.05 / (luminance + 0.05);
  const onInk = (luminance + 0.05) / (INK_LUMINANCE + 0.05);
  return onWhite >= onInk ? "#ffffff" : INK;
}

/** The dark ink and its relative luminance, kept together so they cannot drift. */
const INK = "#15181d";
const INK_LUMINANCE = 0.009;

export function Heatmap({
  arms,
  questionTypes,
  questions,
  cells,
  credit,
  onSelectQuestion,
}: Props) {
  const captionId = useId();
  const [focus, setFocus] = useState<{ arm: ArmId; type: QuestionType } | null>(
    null,
  );

  const types = TYPE_ORDER.filter((t) => questionTypes.some((qt) => qt.id === t));
  const typeMeta = (t: QuestionType) => questionTypes.find((qt) => qt.id === t);

  const focused = focus
    ? summarize(focus.arm, focus.type, questions, cells, credit)
    : null;

  return (
    <div>
      <table
        className="w-full border-collapse text-sm"
        aria-describedby={captionId}
      >
        <caption id={captionId} className="sr-only">
          Accuracy of each approach on each question type. Each cell aggregates
          the questions of that type for this document.
        </caption>
        <thead>
          <tr>
            <th className="w-44 border-b border-border p-2 text-left font-medium text-text-dim">
              Approach
            </th>
            {types.map((t) => (
              <th
                key={t}
                scope="col"
                className="border-b border-border p-2 text-left align-bottom font-medium"
              >
                <span className="text-text">{typeMeta(t)?.label ?? t}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {arms.map((arm) => (
            <tr key={arm.id}>
              <th
                scope="row"
                className="border-b border-border p-2 text-left font-normal text-text"
              >
                {arm.label}
              </th>
              {types.map((t) => {
                const summary = summarize(arm.id, t, questions, cells, credit);
                const isFocus = focus?.arm === arm.id && focus?.type === t;
                return (
                  <td key={t} className="border-b border-border p-1">
                    {summary === null ? (
                      <div className="rounded px-2 py-2 text-center text-xs text-text-faint">
                        —
                      </div>
                    ) : (
                      <button
                        type="button"
                        onMouseEnter={() => setFocus({ arm: arm.id, type: t })}
                        onFocus={() => setFocus({ arm: arm.id, type: t })}
                        onMouseLeave={() => setFocus(null)}
                        onBlur={() => setFocus(null)}
                        onClick={() =>
                          onSelectQuestion?.(summary.grades[0].questionId)
                        }
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left transition-[outline]"
                        style={{
                          background: scoreColor(summary.score),
                          outline: isFocus
                            ? "2px solid var(--text)"
                            : "1px solid rgb(0 0 0 / 0.25)",
                        }}
                        title={`${arm.label} on ${typeMeta(t)?.label ?? t} — click to compare one of these questions`}
                      >
                        <span
                          className="tnum text-xs font-medium"
                          style={{ color: scoreInk(summary.score) }}
                        >
                          {percent(summary.score)}
                        </span>
                        <span className="flex gap-[3px]">
                          {summary.grades.map((g) => (
                            <span
                              key={g.questionId}
                              className="h-3 w-[5px] rounded-sm"
                              // A hairline keeps each grade tick legible against
                              // whichever cell colour it lands on: a red tick on a
                              // red cell is otherwise nearly invisible, and that
                              // tick is the one carrying the bad news.
                              style={{
                                background: GRADE_COLOR[g.grade],
                                boxShadow: "0 0 0 1px rgb(0 0 0 / 0.45)",
                              }}
                            />
                          ))}
                        </span>
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 min-h-[3.5rem] text-sm leading-relaxed text-text-dim">
        {focused && focus ? (
          <p>
            <span className="text-text">
              {arms.find((a) => a.id === focus.arm)?.label}
            </span>{" "}
            on {typeMeta(focus.type)?.label.toLowerCase()} questions:{" "}
            {focused.grades
              .map(
                (g) =>
                  `${g.questionId.split("-").pop()} ${g.grade.replace(/_/g, " ")}`,
              )
              .join(", ")}
            . {focused.grades[0].rationale}
          </p>
        ) : (
          <p>
            {questionTypes.map((qt, i) => (
              <span key={qt.id}>
                {i > 0 ? " " : ""}
                <span className="text-text">{qt.label}:</span> {qt.why}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}
