import Link from "next/link";

import { Overview } from "@/components/Overview";
import { Workbench } from "@/components/Workbench";
import type { DocStatus } from "@/components/RunPanel";
import { loadCatalogue } from "@/lib/catalogue";
import { loadPresets } from "@/lib/presets";
import { loadDocLean, loadManifestIfPresent } from "@/lib/results";
import { groupApproaches, numberWord } from "@/lib/approaches";
import { resultKey } from "@/lib/types";

/**
 * The page is a funnel with a fork in it: what the approaches are, how they are
 * measured, then a choice — run the evals, or read the ones on disk.
 *
 * The fork exists because the two things want opposite screens. Before it, everything
 * is true whether or not this clone has ever run anything, which is what lets a fresh
 * clone show the same argument as a measured one and then offer the only branch it
 * can actually serve.
 */
export default async function Home() {
  const [manifest, catalogue, presets] = await Promise.all([
    loadManifestIfPresent(),
    loadCatalogue(),
    loadPresets(),
  ]);

  // One lean result set per (document, model) pair — a document measured with two
  // models is two entries, and the results view offers the choice.
  const docs = manifest
    ? await Promise.all(manifest.docs.map((d) => loadDocLean(d.doc_id, d.model)))
    : [];

  // Completeness per result set, for the run stage's picker. Keyed by (document,
  // model) because that is what results/ stores: a document fully measured with one
  // model is still unmeasured for another. Derived from the manifest, never
  // asserted: the manifest reports what the files actually contain.
  const status: Record<string, DocStatus> = {};
  for (const d of manifest?.docs ?? []) {
    status[resultKey(d.doc_id, d.model)] = {
      cells: d.cells,
      cellsExpected: d.cells_expected,
      state: d.provenance_state,
    };
  }

  // Which cells already exist, so the run stage can say what it will skip rather
  // than pricing work it is not going to do. Error cells don't count: the
  // pipeline retries them by default, so the run stage must price and queue them.
  const measured: Record<string, string[]> = {};
  for (const doc of docs) {
    measured[resultKey(doc.doc_id, doc.model)] = Object.entries(doc.cells)
      .filter(([, cell]) => !("error" in cell))
      .map(([key]) => key);
  }

  // Arm and question-type metadata comes from the presets dump when there is no
  // manifest to read it from — same values, same shapes, so the sections above the
  // fork render identically either way.
  const arms = manifest?.arms.length ? manifest.arms : presets.arms;
  const questionTypes = manifest?.question_types.length
    ? manifest.question_types
    : presets.question_types;
  const approachCount = groupApproaches(arms).length;

  // Questions per document, for the overview. Read off the first catalogued document
  // rather than asserted as fifteen: the set is data, and a copy of questions.yaml
  // with a shorter one should say so instead of being contradicted by the page.
  const questionsPerDoc =
    presets.questions[catalogue[0]?.doc_id ?? ""]?.length ?? 0;

  // Completeness is reported per document, next to the document, not as a page-level
  // banner. A scoped run leaves an incomplete matrix and a two-cell aggregate must not
  // read as a result — but a warning above the fold said that about a document the
  // reader had not chosen yet, on a page whose first screen is now a choice between
  // running something and reading something. The document picker badges the partial
  // ones and the results view states the cell count for whichever is selected, which
  // is where the caveat is actually load-bearing.
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
          Ask a question of a document, watch {numberWord(approachCount)} extraction
          approaches answer it side by side, and see exactly what each one cost you.
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
            ? "on documents you can read, against an answer key you can check. Nothing is precomputed for you: every number the charts will show comes out of a run you start."
            : docCount === 1
              ? "on a document you can read, against an answer key you can check. One document cannot tell you which approach is better in general, and nothing here claims to — run a second one and watch the answer change."
              : `on ${numberWord(docCount)} documents you can read, against an answer key you can check. ${docCountWord} documents cannot tell you which approach is better in general, and nothing here claims to; the point is watching the answer change when the document does.`}
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

      <p className="mt-6 text-sm text-text-dim">
        <Link
          href="/how-it-works"
          className="text-text underline decoration-border-strong underline-offset-2 hover:decoration-accent"
        >
          How it works
        </Link>{" "}
        — what the {numberWord(approachCount)} approaches actually do, how answers are
        graded, and how to run all of it from a terminal.
      </p>

      <div className="mt-10 border-t border-border pt-10">
        <Workbench
          manifest={manifest}
          docs={docs}
          catalogue={catalogue}
          presets={presets}
          status={status}
          measured={measured}
        />
      </div>

      <footer className="mt-14 space-y-2 border-t border-border pt-6 text-sm text-text-faint">
        <p>
          <Link
            href="/how-it-works"
            className="text-text-dim underline decoration-border underline-offset-2 hover:decoration-accent"
          >
            How it works
          </Link>{" "}
          — approaches, grading, and running it yourself.
        </p>
        {manifest ? (
          <p>
            All results precomputed with{" "}
            <span className="text-text-dim">{manifest.model}</span> on{" "}
            <span className="tnum text-text-dim">
              {manifest.computed_at.slice(0, 10)}
            </span>
            , priced against the rate card of{" "}
            <span className="tnum text-text-dim">{manifest.pricing_snapshot}</span>.
            Model prices change; these numbers do not update themselves.
          </p>
        ) : (
          <p>
            No results in this clone yet.{" "}
            <code className="text-text-dim">results/</code> is generated, not
            committed, so the charts appear once you have run something.
          </p>
        )}
        <p>
          Reading results is replay: every answer was streamed once, recorded, and is
          replayed from disk. Only a run calls an API, and only when you ask it to.
        </p>
      </footer>
    </main>
  );
}
