import { ARM_COLOR } from "@/lib/format";
import { groupApproaches, numberWord } from "@/lib/approaches";
import type { Manifest } from "@/lib/types";

/**
 * What each approach actually does, up front — before the demo, not after it.
 *
 * A reader who doesn't know what "extract then query" means cannot read the
 * charts, and the labels alone don't teach it: "One map-reduce pass into a schema"
 * assumes the reader already knows. So each approach gets a plain description of
 * the mechanism and the shape of its bill, and the manifest supplies where it wins
 * and where it breaks.
 */

/**
 * Mechanism and cost shape, written here rather than generated.
 *
 * The manifest's `short` is a label, not an explanation, so this is the one block
 * of copy on the page that can drift from the pipeline. It is keyed by approach so
 * a new approach shows up with its manifest text and no invented mechanism, and
 * each entry mirrors a section of README.md's methodology — `hybrid_rag` here is
 * the four-step pipeline documented there, not a guess about what hybrid means.
 */
const MECHANISM: Record<string, { how: string; bill: string }> = {
  full_context: {
    how: "Sends the entire document with every question. No retrieval, no preprocessing, nothing discarded — the model sees everything and answers from it.",
    bill: "Nothing up front. Every question pays for the whole document again.",
  },
  cached_context: {
    how: "The same whole-document prompt, but the document is cached so later questions re-read it at a fraction of the price. The document sits behind the cache breakpoint and the question after it, so the cached part is byte-identical across every question.",
    bill: "One cache write up front, then cheap reads — until the cache expires and the write is paid again.",
  },
  naive_rag: {
    how: "Splits the document into fixed-size chunks of 500 tokens with a 50-token overlap, embeds them, and retrieves the five closest to your question. The model only ever sees those five. This is the version most teams ship first: no reranking, no query rewriting.",
    bill: "One embedding pass up front, then five chunks per question — flat, regardless of how big the document is.",
  },
  hybrid_rag: {
    how: "Retrieval done properly, so full context isn't beating a strawman. Each chunk is first given an LLM-written prefix situating it in the document; then keyword search and embedding search each return 20 candidates, the two ranked lists are fused, and a reranker picks the final five.",
    bill: "A real indexing bill up front — those prefixes are LLM calls — then five chunks per question.",
  },
  agentic: {
    how: "Gives the model grep and read-lines tools over the document and lets it search on its own, up to fifteen turns. It decides what to look for, reads what it finds, and searches again.",
    bill: "Nothing up front, but each question costs whatever that question's search happened to need — the one approach whose per-query cost is unpredictable.",
  },
  extract: {
    how: "Reads the document once, in overlapping windows, pulling everything into a predefined schema — then throws the document away. Questions are answered from the extracted record. The schema is hand-written per document type — segments and financial statements for a 10-K, parties and termination rights for a contract, methods and results for a paper — encoding what an analyst would ask before seeing any actual question. It was written before the question set, not fitted to it, so the arm can only answer what the schema anticipated: when a question falls outside it, the answer says so rather than guessing.",
    bill: "The most expensive up-front pass here, then almost nothing per question.",
  },
};

interface Props {
  /** Same shape whether it came from the manifest or the presets dump. */
  arms: Manifest["arms"];
}

/**
 * One label/value row.
 *
 * The values are manifest strings, and they are complete clauses — "Cost scales
 * linearly with queries x document size", "Let the window lapse and the next query
 * pays the write again". So the labels have to be standalone nouns that a clause
 * can sit beside, not sentence openers: "Fails at Let the window lapse and the
 * next query pays the write again" is not English, and no amount of punctuation
 * rescues it. Every row goes through here so the variants inside an approach can't
 * drift back into inline prose.
 */
function Detail({
  label,
  tone,
  children,
}: {
  label: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <dt
        className={`w-28 shrink-0 text-xs uppercase tracking-wide ${tone}`}
      >
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-text-dim">{children}</dd>
    </div>
  );
}

const PAY = "text-text-faint";
const STRENGTH = "text-[#3fa87a]";
const WEAKNESS = "text-[#d9a441]";

export function ApproachGuide({ arms }: Props) {
  const approaches = groupApproaches(arms);

  return (
    <section aria-labelledby="approaches-heading" className="mt-10">
      <div className="max-w-3xl">
        <h2
          id="approaches-heading"
          className="scroll-mt-6 text-base font-medium text-text"
        >
          The {numberWord(approaches.length)} approaches
        </h2>
        <p className="mt-1.5 text-sm text-text-dim">
          Every one of them answers the same questions about the same documents.
          They differ in what they send the model, and in whether you pay for it
          once or on every question — which is why the cheapest is not the most
          accurate, and the crossover moves when the document changes.
        </p>
      </div>

      <ol className="mt-5 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {approaches.map((approach, i) => {
          const mechanism = MECHANISM[approach.key];
          return (
            <li
              key={approach.key}
              className="flex flex-col rounded-md border border-border bg-bg-raised p-4"
            >
              <div className="flex items-baseline gap-2">
                <span className="tnum text-xs text-text-faint">{i + 1}</span>
                <span aria-hidden className="flex shrink-0 gap-1 self-center">
                  {approach.arms.map((arm) => (
                    <span
                      key={arm.id}
                      className="h-2 w-2 rounded-full"
                      style={{ background: ARM_COLOR[arm.id] }}
                    />
                  ))}
                </span>
                <h3 className="text-sm font-medium text-text">
                  {approach.label}
                </h3>
              </div>

              {mechanism ? (
                <p className="mt-2 text-sm text-text-dim">{mechanism.how}</p>
              ) : (
                <p className="mt-2 text-sm text-text-dim">
                  {approach.arms[0].short}
                </p>
              )}

              <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
                {mechanism ? (
                  <Detail label="What you pay" tone={PAY}>
                    {mechanism.bill}
                  </Detail>
                ) : null}
                {/* Strength and weakness come from the single measured run — but an
                    approach measured at two cache lifetimes has a different one at
                    each, so those move down into the variants rather than being
                    represented here by whichever came first. */}
                {approach.arms.length === 1 ? (
                  <>
                    <Detail label="Strength" tone={STRENGTH}>
                      {approach.arms[0].wins}
                    </Detail>
                    <Detail label="Weakness" tone={WEAKNESS}>
                      {approach.arms[0].breaks}
                    </Detail>
                  </>
                ) : null}
              </dl>

              {/* Caching is measured twice and the two runs differ only in price,
                  so the variants belong inside their approach rather than beside
                  it — the whole point is that they are the same prompt. */}
              {approach.arms.length > 1 ? (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="text-xs uppercase tracking-wide text-text-faint">
                    Measured at {numberWord(approach.arms.length)} cache lifetimes
                  </p>
                  <ul className="mt-2 space-y-2">
                    {approach.arms.map((arm) => (
                      <li
                        key={arm.id}
                        className="border-l-2 pl-3"
                        style={{ borderColor: ARM_COLOR[arm.id] }}
                      >
                        <p className="text-sm text-text">{arm.label}</p>
                        <dl className="mt-1 space-y-1 text-sm">
                          <Detail label="Strength" tone={STRENGTH}>
                            {arm.wins}
                          </Detail>
                          <Detail label="Weakness" tone={WEAKNESS}>
                            {arm.breaks}
                          </Detail>
                        </dl>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <p className="mt-4 max-w-3xl text-sm text-text-dim">
        <span className="text-text">
          {numberWord(approaches.length)} approaches,{" "}
          {numberWord(arms.length)} measured runs.
        </span>{" "}
        Caching is not a retrieval approach — it is the full-context prompt at a
        different price — so it is measured at both cache lifetimes and the two runs
        share a colour. Their accuracy should be identical, because the prompts are.
      </p>
    </section>
  );
}
