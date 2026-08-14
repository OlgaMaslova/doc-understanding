import Link from "next/link";

import { ApproachGuide } from "@/components/ApproachGuide";
import { Methodology } from "@/components/Methodology";
import { RunItYourself } from "@/components/RunItYourself";
import { cap, groupApproaches, numberWord } from "@/lib/approaches";
import { loadManifestIfPresent } from "@/lib/results";

/**
 * The reference page: what the approaches are, how a grade was decided, and where to
 * go to run the whole thing.
 *
 * Split out of the main page because it answers questions a reader has at a
 * different time. Someone who wants to know what "extract then query" actually is, or
 * why a cell is graded `hallucinated` rather than `incorrect`, comes looking; they
 * should find a page, not a scroll position.
 *
 * Everything here comes out of the manifest, which this branch commits along with the
 * results it describes. The local copy of the site can also ask the pipeline directly
 * — that is how it stays complete on a clone that has never run anything — but a
 * static build has no pipeline to ask and no need to: the measurements are right here.
 */
export const metadata = {
  title: "How it works — Document Understanding, Measured",
  description:
    "The seven approaches, how answers are graded, and how to run the pipeline yourself.",
};

export default async function HowItWorksPage() {
  const manifest = await loadManifestIfPresent();

  const arms = manifest?.arms ?? [];
  const grades = manifest?.grades ?? [];
  const credit = manifest?.credit;

  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <header className="max-w-3xl space-y-4">
        <Link
          href="/"
          className="text-sm text-text-faint underline decoration-dotted hover:text-text-dim"
        >
          ← Back to the comparison
        </Link>
        <h1 className="text-2xl font-medium leading-snug text-text sm:text-3xl">
          How it works
        </h1>
        {/* Derived, like the count in the guide below it: the arm set depends on
            the providers this build's results were measured with, and a hardcoded
            number word goes stale the first time someone adds one. */}
        <p className="text-base leading-relaxed text-text-dim">
          {cap(numberWord(groupApproaches(arms).length))} ways to get a document in
          front of a model, one answer key, and a judge. This page is the part you
          should be able to check before believing any number the charts show you.
        </p>
      </header>

      {arms.length ? (
        <ApproachGuide arms={arms} />
      ) : (
        <p className="mt-10 max-w-3xl text-sm leading-relaxed text-text-dim">
          The approach list comes from{" "}
          <code className="text-text-dim">results/manifest.json</code>, and this build
          was made without one. Clone the repository to see it.
        </p>
      )}

      {grades.length && credit ? (
        <div className="mt-14 border-t border-border pt-10">
          <Methodology grades={grades} credit={credit} />
        </div>
      ) : null}

      {/* The loudest break on the page. "You can run this" is the claim the whole
          project rests on, and where to do it should not read as one more reference
          subsection after the grading rubric. */}
      <div className="mt-20 border-t-2 border-border-strong pt-12">
        <RunItYourself />
      </div>

      <div className="mt-14 border-t border-border pt-6">
        <Link
          href="/"
          className="text-sm text-text underline decoration-border-strong underline-offset-2 hover:decoration-accent"
        >
          ← Back to the documents
        </Link>
      </div>
    </main>
  );
}
