import { ARM_COLOR, percent, usd } from "@/lib/format";
import type { ModelComparison as Comparison } from "@/lib/models";

/**
 * The same approaches, measured with two models, side by side.
 *
 * The page's argument is that the approach is the decision. This is the other half
 * of the bill: the approach sets the *shape* of the cost curve, and the model sets
 * its height. Holding one still and swapping the other is the only way to see
 * which of the two a given number belongs to, and the pipeline is built so that
 * the swap really does hold everything else still — same documents, same
 * questions, same answer key, same judge, same indexing model.
 *
 * Every number and every claim below is derived in `lib/models.ts` from the
 * committed result sets. Nothing here names a model or asserts that the cheap one
 * is good enough; the widest divergence is found in the data and stated, whatever
 * it happens to be. A re-run that overturns the conclusion rewrites this section
 * instead of being contradicted by it.
 *
 * The row that diverges is the point. An average across approaches would report
 * "a few points cheaper and a few points worse" and bury the only thing a reader
 * needs: on most approaches the swap costs almost nothing, and on one of them it
 * costs a fifth of the answers.
 */

/** A score gap this wide is the difference between approaches, not noise. */
const MATERIAL_GAP = 0.1;

export function ModelComparison({ comparison }: { comparison: Comparison }) {
  const { models, cheapest, dearest, summary, widestGap, gapExcludingWidest } =
    comparison;
  const cheap = summary[cheapest];
  const dear = summary[dearest];
  const points = (credit: number) => Math.round(credit * 100);
  const ratio = (value: number) =>
    value >= 10 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
  const divergent =
    widestGap && (widestGap.scoreGap ?? 0) >= MATERIAL_GAP ? widestGap : null;

  return (
    <section aria-labelledby="models-heading" className="mt-10">
      <h2 id="models-heading" className="text-base font-medium text-text">
        The approach is one decision. The model is the other.
      </h2>
      <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-text-dim">
        Every approach below was measured twice, once with each model, over the same{" "}
        {comparison.questions} questions and the same {comparison.docIds.length}{" "}
        documents, graded by the same judge against the same answer key. So the
        difference between the two columns is the model and nothing else.{" "}
        <span className="font-mono text-text">{cheapest}</span> answers at{" "}
        <span className="tnum text-text">{ratio(comparison.costRatio)}</span> less
        per query than{" "}
        <span className="font-mono text-text">{dearest}</span>, and scores{" "}
        <span className="tnum text-text">{percent(cheap.score)}</span> against{" "}
        <span className="tnum text-text">{percent(dear.score)}</span>.
      </p>
      {divergent ? (
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-dim">
          That average hides the finding, though. The cheap model gives up{" "}
          <span className="tnum text-text">
            {points(divergent.scoreGap ?? 0)} points
          </span>{" "}
          on {divergent.label.toLowerCase()}
          {gapExcludingWidest !== null ? (
            <>
              {" "}
              and at most{" "}
              <span className="tnum text-text">
                {points(gapExcludingWidest)}
              </span>{" "}
              on every other approach
            </>
          ) : null}
          . Which approach you picked decides whether the cheaper model is a saving
          or a downgrade.
        </p>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">
            Accuracy and cost per query for each approach, by answering model
          </caption>
          <thead>
            <tr className="text-left text-text-dim">
              <th rowSpan={2} className="border-b border-border p-2 font-medium">
                Approach
              </th>
              {models.map((model) => (
                <th
                  key={model}
                  colSpan={2}
                  scope="colgroup"
                  className="border-b border-border px-2 pb-1 pt-2 font-mono text-xs font-normal text-text"
                >
                  {model}
                </th>
              ))}
              <th rowSpan={2} className="border-b border-border p-2 font-medium">
                Cheaper by
              </th>
            </tr>
            <tr className="text-left text-text-faint">
              {models.flatMap((model) => [
                <th
                  key={`${model}-score`}
                  scope="col"
                  className="border-b border-border px-2 pb-2 text-xs font-normal"
                >
                  Score
                </th>,
                <th
                  key={`${model}-cost`}
                  scope="col"
                  className="border-b border-border px-2 pb-2 text-xs font-normal"
                >
                  Per query
                </th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => {
              const wide = (row.scoreGap ?? 0) >= MATERIAL_GAP;
              // Flagged on the model that lost the points, not across the row: the
              // gap is a fact about one column, and colouring both would read as
              // "something is wrong with this approach" instead of "this model is
              // where it falls down".
              const lowest = Math.min(
                ...Object.values(row.byModel).map((c) => c.score),
              );
              return (
                <tr key={row.key}>
                  <th
                    scope="row"
                    className="border-b border-border p-2 text-left font-normal"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: ARM_COLOR[row.arms[0]] }}
                      />
                      <span className="text-text">{row.label}</span>
                    </span>
                  </th>
                  {models.flatMap((model) => {
                    const cell = row.byModel[model];
                    return [
                      <td
                        key={`${model}-score`}
                        className="tnum border-b border-border p-2 text-text-dim"
                        // Two cache lifetimes average into one row; say so on
                        // hover rather than splitting a row that exists to line
                        // the models up.
                        title={
                          cell
                            ? `${cell.arms.join(", ")} — ${cell.n} graded cells`
                            : undefined
                        }
                      >
                        {cell ? (
                          <span
                            className={
                              wide && cell.score === lowest
                                ? "text-[#d9a441]"
                                : undefined
                            }
                            title={
                              wide && cell.score === lowest
                                ? `${points(row.scoreGap ?? 0)} points behind on this approach.`
                                : undefined
                            }
                          >
                            {percent(cell.score)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>,
                      <td
                        key={`${model}-cost`}
                        className="tnum border-b border-border p-2 text-text-dim"
                      >
                        {cell ? usd(cell.perQueryUsd) : "—"}
                      </td>,
                    ];
                  })}
                  <td className="tnum border-b border-border p-2 text-text-dim">
                    {row.costRatio ? ratio(row.costRatio) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-text-faint">
        Score is mean credit over every question of every shared document —{" "}
        {comparison.docIds.join(", ")}. Per query excludes anything paid once:
        indexing, an extraction pass, a cache warm. Caching is one row per model
        because the lifetime is a provider capability, not a strategy — the
        cache-lifetime variants are averaged where a model has two, and the
        provider-default one stands alone where the request cannot choose. Indexing
        and grading ran on the same model throughout, so nothing in this table is a
        cheaper judge marking a cheaper model&apos;s homework.
      </p>
    </section>
  );
}
