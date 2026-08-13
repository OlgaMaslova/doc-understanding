import { GRADE_COLOR } from "@/lib/format";
import type { GradeId, Manifest } from "@/lib/types";

/**
 * How an answer was judged.
 *
 * This sits low on the reference page, unlike the approach guide: the grade scale
 * answers a question a reader has *after* seeing a heatmap cell they don't believe,
 * and the heatmap is legible without it.
 *
 * The question taxonomy used to be explained here too. It is introduced where it is
 * actually used instead — the question picker names each type and what it demands,
 * and the heatmap legend does the same — so a second, fuller telling this far down the
 * page was explaining the rows of a chart the reader had already read.
 */

/**
 * What each grade means, condensed from the judge's rubric in
 * `pipeline/docrace/grading.py`. The manifest carries only the numeric credit, and
 * the credit is the uninteresting half — "hallucinated" and "incorrect" both score
 * zero, and the whole point of separating them is that one is much worse.
 */
const GRADE_MEANING: Record<GradeId, string> = {
  correct:
    "States the substance of the reference answer. Different wording, extra correct detail, and a different order are all fine.",
  partial:
    "Gets some of it right but omits a material part, or is right in substance while wrong on a figure or a count.",
  incorrect:
    "Contradicts the reference answer, or declines to answer a question the document does in fact answer.",
  hallucinated:
    "Confidently invents a value, provision, count, or citation that does not exist. This is the grade for answering an unanswerable question with a specific claim.",
  correctly_refused:
    "The document has no answer and the approach says so. This is a success, not a failure, which is why it earns full credit.",
};

interface Props {
  /** As the manifest records them. */
  grades: Manifest["grades"];
  credit: Manifest["credit"];
}

export function Methodology({ grades, credit }: Props) {
  return (
    <div className="space-y-10">
      <section aria-labelledby="grading-heading" className="space-y-3">
        <div className="max-w-3xl">
          <h2 id="grading-heading" className="text-base font-medium text-text">
            How answers are graded
          </h2>
          <p className="mt-1.5 text-sm text-text-dim">
            Every answer is graded once, offline, against the reference answer
            committed with the question — a judge model does the first pass, the
            rationale is kept next to the grade so a bad call is visible, and it can
            be overridden by hand before results are committed. The deployed site
            grades nothing at request time. An approach&apos;s score is the mean
            credit across that document&apos;s questions.
          </p>
        </div>
        <dl className="space-y-2">
          {grades.map((grade) => (
            <div key={grade.id} className="flex flex-wrap gap-x-3 gap-y-1">
              {/* The swatch carries the colour and the label stays --text. Two of
                  the five grade colours sit near 3:1 on this ground — fine for a
                  2px dot under SC 1.4.11, not fine for a word. */}
              <dt className="flex w-40 shrink-0 items-baseline gap-2 text-sm text-text">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 translate-y-[-1px] self-center rounded-full"
                  style={{ background: GRADE_COLOR[grade.id] }}
                />
                {grade.label}
              </dt>
              <dd className="tnum w-16 shrink-0 text-sm text-text-faint">
                {credit[grade.id]?.toFixed(1) ?? "—"}
              </dd>
              <dd className="min-w-0 flex-1 text-sm text-text-dim">
                {GRADE_MEANING[grade.id]}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
