import Link from "next/link";

import { ComparisonView } from "@/components/ComparisonView";
import { ModelComparison } from "@/components/ModelComparison";
import { Overview } from "@/components/Overview";
import { RepoLink } from "@/components/RepoLink";
import { loadCatalogue } from "@/lib/catalogue";
import { loadDocLean, loadManifestIfPresent } from "@/lib/results";
import { groupApproaches, numberWord } from "@/lib/approaches";
import { compareModels } from "@/lib/models";

/**
 * The page, on the branch that deploys as a static site.
 *
 * It used to be a funnel with a fork in it: what the approaches are, how they are
 * measured, then a choice — run the evals, or read the ones on disk. A static host
 * has no pipeline and no key, so only one of those branches exists here and the
 * choice was a door with nothing behind it. What replaced it is two calls to action
 * — how it works, and the repository — stated inline once in the setup and then as
 * one band of buttons at the seam, where the charts have given a reader something to
 * disbelieve and they want either the method or the code.
 */
export default async function Home() {
  const [manifest, catalogue] = await Promise.all([
    loadManifestIfPresent(),
    loadCatalogue(),
  ]);

  // One lean result set per (document, model) pair — a document measured with two
  // models is two entries, and the comparison offers the choice.
  const docs = manifest
    ? await Promise.all(manifest.docs.map((d) => loadDocLean(d.doc_id, d.model)))
    : [];

  const arms = manifest?.arms ?? [];
  const questionTypes = manifest?.question_types ?? [];
  const approachCount = groupApproaches(arms).length;
  // A build with no manifest knows nothing about the approaches, and "the zero
  // extraction approaches" is how derived copy embarrasses itself.
  const approaches = approachCount
    ? `${numberWord(approachCount)} extraction approaches`
    : "several extraction approaches";

  // The model comparison, when the committed results support one: two models that
  // have each measured the same document completely. Null on a build with one model,
  // or none — which is why it is a section that appears rather than a section with
  // placeholders in it.
  const comparison = manifest ? compareModels(manifest, docs) : null;

  // Questions per document, for the overview. Read off a measured set rather than
  // asserted as fifteen: the set is data, and a copy of questions.yaml with a
  // shorter one should say so instead of being contradicted by the page.
  const questionsPerDoc = docs[0]?.questions.length ?? 0;

  // Distinct documents, not result sets: a document measured with two models is
  // still one document you can read.
  const docCount = new Set(docs.map((d) => d.doc_id)).size;
  const docCountWord =
    numberWord(docCount).charAt(0).toUpperCase() + numberWord(docCount).slice(1);

  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <header className="max-w-3xl space-y-4">
        <p className="text-xs uppercase tracking-[0.18em] text-accent">
          Document Understanding, Measured
        </p>
        <h1 className="text-2xl font-medium leading-snug text-text sm:text-3xl">
          Everyone has an opinion about RAG vs. long context. This one you can run.
        </h1>
        <p className="text-base leading-relaxed text-text-dim">
          Ask a question of a document, watch {approaches} answer it side by side, and
          see exactly what each one cost you.
        </p>

        {/* Plain prose, not a callout.
            In a bordered box with a bolded "This is not a benchmark", this read as a
            disclaimer — a thing to skim past — when it is the actual description of
            what the tool does. What matters is stated positively: it compares quality
            against cost, and which approach wins depends on the document. The
            document count is derived because runs are scoped, and a page claiming
            three documents while holding one is the kind of thing this project cannot
            afford to get wrong. */}
        <p className="text-base leading-relaxed text-text-dim">
          It is a comparison tool. Which approach wins depends on the document, the
          questions you ask of it, and how many times you ask — so it measures quality
          and cost side by side,{" "}
          {docCount === 0
            ? "on documents you can read, against an answer key you can check."
            : docCount === 1
              ? "on a document you can read, against an answer key you can check. One document cannot tell you which approach is better in general, and nothing here claims to."
              : `on ${numberWord(docCount)} documents you can read, against an answer key you can check. ${docCountWord} documents cannot tell you which approach is better in general, and nothing here claims to; the point is watching the answer change when the document does.`}
        </p>

        {/* Said once, at the top, in the plainest terms available: these numbers are
            recordings, and the thing that produced them is a clone away. A reader who
            arrives expecting to press a button should find out here rather than by
            hunting for one. */}
        <p className="text-base leading-relaxed text-text-dim">
          This is a static deployment — every answer below was measured once and is
          replayed from a recording, so nothing here spends anything or needs a key.{" "}
          <RepoLink>If you want to run it yourself</RepoLink>, the pipeline, the
          documents, and the question set are all in the repository.
        </p>
      </header>

      {arms.length && catalogue.length ? (
        <Overview
          arms={arms}
          questionTypes={questionTypes}
          docs={catalogue}
          questionsPerDoc={questionsPerDoc}
        />
      ) : null}

      {comparison ? <ModelComparison comparison={comparison} /> : null}

      {/* The two things a reader wants after the summary tables, as two buttons in
          one band rather than scattered across the seam. This used to be a sentence
          with a link in it, a rule, and then a third link floating right above the
          comparison — three weights of the same two invitations. */}
      <div className="mt-10 border-y border-border py-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/how-it-works"
            className="inline-block rounded border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-90"
          >
            How it works
          </Link>
          <RepoLink variant="button">Run it yourself</RepoLink>
        </div>
        <p className="mt-3 max-w-3xl text-xs text-text-faint">
          What each approach actually does and how answers are graded · the pipeline,
          the documents, and the question set, in the repository.
        </p>
      </div>

      <div className="mt-10">
        {manifest && docs.length ? (
          <ComparisonView
            manifest={manifest}
            docs={docs}
            catalogue={catalogue}
          />
        ) : (
          <section className="max-w-3xl space-y-3">
            <h2 className="text-base font-medium text-text">No measurements here</h2>
            <p className="text-sm leading-relaxed text-text-dim">
              This build found no results to show, which on a deployment of this
              branch means the build was made from a checkout without them.{" "}
              <RepoLink>The repository</RepoLink> has the pipeline that produces them.
            </p>
          </section>
        )}
      </div>

      <footer className="mt-14 space-y-2 border-t border-border pt-6 text-sm text-text-faint">
        {manifest ? (
          <p>
            All results measured with{" "}
            <span className="text-text-dim">{manifest.model}</span> on{" "}
            <span className="tnum text-text-dim">
              {manifest.computed_at.slice(0, 10)}
            </span>
            , priced against the rate card of{" "}
            <span className="tnum text-text-dim">{manifest.pricing_snapshot}</span>.
            Model prices change; these numbers do not update themselves.
          </p>
        ) : null}
        <p>
          Every answer was streamed once, recorded, and is replayed from a file this
          site was built from. Nothing here calls an API.
        </p>
      </footer>
    </main>
  );
}
