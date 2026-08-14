import Link from "next/link";

import { ARM_COLOR, GRADE_COLOR, tokens } from "@/lib/format";
import { cap, groupApproaches, numberWord } from "@/lib/approaches";
import type { GradeId, Manifest } from "@/lib/types";

/**
 * The setup, stated once, above the fork.
 *
 * This was three numbered steps — pick a question, watch the answers, read the
 * charts — and it was wrong twice over. Only the first was something a reader does;
 * the other two were the page describing its own output back to itself, numbered as
 * if they were instructions. And all three described the *results* branch, so the
 * choice underneath them arrived unexplained.
 *
 * What has to be true before that choice makes sense is the experiment: what is
 * being compared, over what, asked what, measured how. Four stat tiles, and the
 * colour in them is never decoration — every swatch is an encoding the reader meets
 * again below: the approach colours from the charts, the grade scale from the
 * heatmap, the document sizes as actual proportional bars. Nothing here asks to be
 * decoded by colour alone; the dots and strips are previews, and the text beside
 * them carries the identity.
 */

interface Props {
  arms: Manifest["arms"];
  questionTypes: Manifest["question_types"];
  /**
   * The documents available to ask, from the catalogue rather than the manifest.
   *
   * This sits above the fork, so it describes what the project can do — and a
   * document you have fetched but not measured is still one you can pick and run.
   * Describing only the measured ones understated the page on a fresh clone to
   * exactly nothing.
   */
  docs: { domain: string; tokens: number }[];
  /** Questions per document, when the preset set is known. Zero hides the figure. */
  questionsPerDoc: number;
}

/** The grade scale in rubric order, best to worst — the heatmap's colour ramp. */
const GRADE_SCALE: GradeId[] = [
  "correct",
  "correctly_refused",
  "partial",
  "incorrect",
  "hallucinated",
];

/**
 * One labelled fact, as a stat tile: the figure is the headline, the sentence
 * supports it, and the strip between them is a small preview of an encoding the
 * charts use for real.
 */
function Fact({
  label,
  stat,
  strip,
  children,
}: {
  label: string;
  stat: string;
  strip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-raised p-4">
      <p className="text-xs uppercase tracking-wide text-text-faint">{label}</p>
      {/* No .tnum here — in this app it swaps to a monospace stack, which is for
          numeric table columns, not headlines. "Six approaches" is prose. */}
      <p className="mt-1 text-xl font-medium leading-snug text-text">{stat}</p>
      {strip ? <div className="mt-2.5">{strip}</div> : null}
      <p className="mt-2.5 text-sm leading-relaxed text-text-dim">{children}</p>
    </div>
  );
}

export function Overview({ arms, questionTypes, docs, questionsPerDoc }: Props) {
  const approaches = groupApproaches(arms);
  const docCount = docs.length;
  const maxTokens = Math.max(...docs.map((d) => d.tokens), 1);
  const domains = docs.map((d) => d.domain).join(", ");
  const smallest = tokens(Math.min(...docs.map((d) => d.tokens), Infinity));
  const largest = tokens(maxTokens);

  // A clone with one document has to read correctly too: "one documents, from 17k to
  // 17k tokens" is how derived copy embarrasses itself.
  const range =
    smallest === largest
      ? `${smallest} tokens`
      : `${smallest} to ${largest} tokens`;

  return (
    <section aria-labelledby="overview-heading" className="mt-10">
      <h2 id="overview-heading" className="text-base font-medium text-text">
        The experiment
      </h2>
      <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-text-dim">
        One question, asked of one document, answered {numberWord(approaches.length)}{" "}
        ways at once — then priced and graded. Everything the charts claim comes from
        that and nothing else.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Fact
          label="Compared"
          stat={`${cap(numberWord(approaches.length))} approaches`}
          strip={
            // The chart colours, in the charts' fixed order. Related approaches
            // deliberately share a colour family — caching is full context at a
            // different price — so two similar dots are the design, not a bug.
            // Nothing has to be decoded here; each dot names itself on hover and
            // the guide is one click away.
            <div aria-hidden className="flex items-center gap-1.5">
              {approaches.map((a) => (
                <span
                  key={a.key}
                  title={a.label}
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: ARM_COLOR[a.arms[0].id] }}
                />
              ))}
            </div>
          }
        >
          From the whole document in the prompt, to retrieved chunks, to one
          extraction pass — each in the colour the charts use.{" "}
          <Link
            href="/how-it-works"
            className="text-text-dim underline decoration-border underline-offset-2 hover:decoration-accent"
          >
            What each one does
          </Link>
          .
        </Fact>

        <Fact
          label="Over"
          stat={
            docCount === 1 ? "One document" : `${cap(numberWord(docCount))} documents`
          }
          strip={
            // Real proportions, not an illustration: length is the encoding and one
            // hue carries it. The 9x spread between the paper and the 10-K is the
            // experiment's whole x-axis, so it is worth a picture this small.
            <div className="space-y-1">
              {docs.map((d) => (
                <div key={d.domain} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-1.5 shrink-0 rounded-r-full bg-accent"
                    style={{
                      // All bars share the 60% budget so the labels get the rest —
                      // a max-width clamp here would truncate only the longest bar
                      // and quietly lie about the ratio the strip exists to show.
                      width: `${Math.max((d.tokens / maxTokens) * 60, 2)}%`,
                      opacity: 0.55 + 0.45 * (d.tokens / maxTokens),
                    }}
                  />
                  <span className="tnum whitespace-nowrap text-[11px] text-text-faint">
                    {d.domain} · {tokens(d.tokens)}
                  </span>
                </div>
              ))}
            </div>
          }
        >
          {cap(domains)} — {range}. Size is the variable that moves the answer.
        </Fact>

        <Fact
          label="Asked"
          stat={
            questionsPerDoc
              ? `${questionsPerDoc} questions × ${questionTypes.length} kinds`
              : `${cap(numberWord(questionTypes.length))} kinds of question`
          }
          strip={
            <div className="flex flex-wrap gap-1">
              {questionTypes.map((t) => (
                <span
                  key={t.id}
                  title={t.why}
                  className="rounded border border-border px-1.5 py-0.5 text-[11px] leading-none text-text-dim"
                >
                  {t.label}
                </span>
              ))}
            </div>
          }
        >
          From single-passage lookups to ones the document does not answer at all.
          The kind decides whether an approach can answer it in principle.
        </Fact>

        <Fact
          label="Measured"
          stat="Cost and accuracy"
          strip={
            // The grade scale, best to worst — the same ramp the heatmap and the
            // grade dots use. A preview with names on hover, not a legend.
            <div aria-hidden className="flex h-1.5 max-w-[12rem] gap-0.5">
              {GRADE_SCALE.map((g) => (
                <span
                  key={g}
                  title={g.replace("_", " ")}
                  className="flex-1 first:rounded-l-full last:rounded-r-full"
                  style={{ background: GRADE_COLOR[g] }}
                />
              ))}
            </div>
          }
        >
          Total cost against query volume, and every answer graded from correct to
          hallucinated. Cheap and wrong is the combination worth finding before you
          ship it.
        </Fact>
      </div>
    </section>
  );
}
