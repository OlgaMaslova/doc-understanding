import Link from "next/link";

import { ApproachGuide } from "@/components/ApproachGuide";
import { Methodology } from "@/components/Methodology";
import { RunEvals } from "@/components/RunEvals";
import { loadPresets } from "@/lib/presets";
import { loadManifestIfPresent } from "@/lib/results";

/**
 * The reference page: what the approaches are, how a grade was decided, and how to
 * run the whole thing from a terminal.
 *
 * Split out of the main page because it answers questions a reader has at a
 * different time. The main page is a choice — run something, or read what has been
 * run — and three screens of explanation sitting under that choice made it look like
 * reading material with a control panel attached. Someone who wants to know what
 * "extract then query" actually is, or why a cell is graded `hallucinated` rather
 * than `incorrect`, comes looking; they should find a page, not a scroll position.
 *
 * Everything here reads from the presets dump first and the manifest second, so the
 * page is complete on a clone that has never run anything — which is exactly when
 * someone is most likely to be reading it.
 */
export const metadata = {
  title: "How it works — Document Understanding, Measured",
  description:
    "The seven approaches, how answers are graded, and how to run the pipeline yourself.",
};

export default async function HowItWorksPage() {
  const [manifest, presets] = await Promise.all([
    loadManifestIfPresent(),
    loadPresets(),
  ]);

  const arms = manifest?.arms.length ? manifest.arms : presets.arms;
  const grades = manifest?.grades.length ? manifest.grades : presets.grades;
  const credit = manifest?.credit ?? presets.credit;

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
        <p className="text-base leading-relaxed text-text-dim">
          Seven ways to get a document in front of a model, one answer key, and a
          judge. This page is the part you should be able to check before believing
          any number the charts show you.
        </p>
      </header>

      {arms.length ? (
        <ApproachGuide arms={arms} />
      ) : (
        <p className="mt-10 max-w-3xl text-sm leading-relaxed text-text-dim">
          The approach list comes from the pipeline, and this copy of the site cannot
          reach it. Clone the repository to see it.
        </p>
      )}

      {grades.length ? (
        <div className="mt-14 border-t border-border pt-10">
          <Methodology grades={grades} credit={credit} />
        </div>
      ) : null}

      {/* The loudest break on the page. "You can run this" is the claim the whole
          project rests on, and the instructions for doing it should not read as one
          more reference subsection after the grading rubric. */}
      <div className="mt-20 border-t-2 border-border-strong pt-12">
        <RunEvals />
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
