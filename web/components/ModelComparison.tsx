import { ARM_COLOR, percent, tokens, usd } from "@/lib/format";
import { MATERIAL_GAP, type ModelComparison as Comparison } from "@/lib/models";

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
 * Written in questions rather than in score. A reader arrives here asking which
 * model to use, and "the cheap one gives up 18 points on agentic search" does not
 * answer that — it is a unit you have to convert before you can act on it, and the
 * conversion is the whole content. Six questions in thirty, all of them the model
 * never finishing, is the same measurement stated as the thing being bought.
 *
 * Every number and every claim below is derived in `lib/models.ts` from the
 * committed result sets. Nothing here names a model or decides in advance which
 * one wins; which model is cheaper, where the two diverge, and what going cheap
 * costs there are all read off the data. A re-run that overturns the
 * recommendation rewrites this section instead of being contradicted by it — and
 * one where no approach diverges drops the recommendation entirely, because then
 * the honest advice is to pick on price.
 */

export function ModelComparison({ comparison }: { comparison: Comparison }) {
  const { models, cheapest, dearest, divergence, questions } = comparison;
  const ratio = (value: number) =>
    value >= 10 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
  const model = (id: string) => (
    <span className="font-mono text-text">{id}</span>
  );
  const count = (value: number) => (
    <span className="tnum text-text">{value}</span>
  );
  /** How far behind the cheaper model falls on the approaches that don't diverge. */
  const elsewhere = !divergence ? null : divergence.worstElsewhere > 0 ? (
    <>
      at most {count(divergence.worstElsewhere)} more question
      {divergence.worstElsewhere === 1 ? "" : "s"} wrong out of {questions}
    </>
  ) : (
    <>no more questions wrong than the expensive one</>
  );

  return (
    <section aria-labelledby="models-heading" className="mt-10">
      <h2 id="models-heading" className="text-base font-medium text-text">
        Which model should you use?
      </h2>
      <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-text-dim">
        Both models answered the same {questions} questions about the same{" "}
        {comparison.docIds.length} documents, and the same judge graded both
        against the same answer key. So anything different below is the model,
        not the test. {model(cheapest)} costs{" "}
        <span className="tnum text-text">{ratio(comparison.costRatio)}</span>{" "}
        less per question than {model(dearest)}.
      </p>

      {divergence ? (
        <>
          {/* The two sentences a reader came for: it doesn't matter, except here,
              where it matters like this. Counted in questions, because that is the
              unit the reader is buying. */}
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-dim">
            {divergence.othersDiverging === 0 ? (
              <>
                On every approach but one, the cheaper model is the same model
                for your purposes: it gets {elsewhere}. The exception is{" "}
                {divergence.row.label.toLowerCase()}:{" "}
              </>
            ) : (
              <>
                The model matters on {divergence.othersDiverging + 1} of the
                approaches below. On the rest the cheaper one gets {elsewhere}.
                The worst of them is {divergence.row.label.toLowerCase()}:{" "}
              </>
            )}
            {model(divergence.weaker)} gets {count(divergence.weakerWrong)} of
            the {questions} wrong where {model(divergence.stronger)} gets{" "}
            {divergence.strongerWrong === 0 ? (
              <>none wrong</>
            ) : (
              <>{count(divergence.strongerWrong)} wrong</>
            )}
            .
            {divergence.weakerUnfinished >= divergence.weakerWrong &&
            divergence.weakerWrong > 0 ? (
              <>
                {" "}
                And they fail the same way every time: it keeps searching until
                it runs out of tool calls, and answers nothing at all.
              </>
            ) : divergence.weakerUnfinished > 0 ? (
              <>
                {" "}
                On {count(divergence.weakerUnfinished)} of those it answered
                nothing at all — it ran out of tool calls still searching.
              </>
            ) : null}
          </p>

          {/* Nobody picks the divergent approach for fun, so "just use another
              one" is only advice while the alternatives still fit. What decides
              that is document size, and the two shared documents are different
              sizes — so the page can measure which way each bill grows instead of
              asserting it. */}
          {divergence.scalesFlatterThanRefuge &&
          divergence.refuge &&
          comparison.sizeSpan ? (
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-dim">
              Which is worse than it sounds, because nobody picks{" "}
              {divergence.row.label.toLowerCase()} for fun. You reach for it
              when the document is too big to put in the prompt at all, and the
              numbers here already lean that way: going from the{" "}
              {tokens(comparison.sizeSpan.small)}-token document to the{" "}
              {tokens(comparison.sizeSpan.large)}-token one, its cost per
              question rose{" "}
              <span className="tnum text-text">
                {ratio(divergence.row.costGrowth ?? 1)}
              </span>
              , while{" "}
              <span className="text-text">
                {divergence.refuge.label.toLowerCase()}
              </span>
              , which pays for the whole document every time, rose{" "}
              <span className="tnum text-text">
                {ratio(divergence.refuge.costGrowth ?? 1)}
              </span>
              . The approaches that beat it here are the ones that stop being
              available first — and the documents that force you onto{" "}
              {divergence.row.label.toLowerCase()} are the same documents that
              force you onto {model(divergence.stronger)}.
            </p>
          ) : null}

          {/* The decision itself, stated as a decision. */}
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-dim">
            So: at these sizes, {model(divergence.weaker)}.
            {divergence.refuge ? (
              <>
                {" "}
                Both documents here fit in a prompt, and while that holds{" "}
                <span className="text-text">
                  {divergence.refuge.label.toLowerCase()}
                </span>{" "}
                {divergence.refugeDominates
                  ? "beats"
                  : "is the cheaper model's best showing against"}{" "}
                {divergence.row.label.toLowerCase()} on both answers and price —{" "}
                <span className="tnum text-text">
                  {percent(divergence.refuge.byModel[divergence.weaker].score)}
                </span>{" "}
                at{" "}
                <span className="tnum text-text">
                  {usd(
                    divergence.refuge.byModel[divergence.weaker].perQueryUsd,
                  )}
                </span>{" "}
                a question.
              </>
            ) : null}{" "}
            Once a document stops fitting, budget for{" "}
            {model(divergence.stronger)} — or measure {model(divergence.weaker)}{" "}
            on a document that size before you trust it, because nothing here
            has.
          </p>
        </>
      ) : (
        // No approach diverges, so there is no model advice to give beyond price —
        // and inventing some would be the failure this section exists to avoid.
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-dim">
          No approach separates the two models by enough to matter here, so the
          cheaper one is the answer on every approach measured.
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">
            Answers right and cost per query for each approach, by answering
            model
          </caption>
          <thead>
            <tr className="text-left text-text-dim">
              <th
                rowSpan={2}
                className="border-b border-border p-2 font-medium"
              >
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
              <th
                rowSpan={2}
                className="border-b border-border p-2 font-medium"
              >
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
                  Answers right
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
              // Flagged on the model that lost the answers, not across the row: the
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
                                ? `Gets ${cell.wrong} of these answers wrong` +
                                  (cell.unfinished
                                    ? `, ${cell.unfinished} of them by never finishing.`
                                    : ".")
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
    </section>
  );
}
