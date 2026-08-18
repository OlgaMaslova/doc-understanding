"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { ComparisonView } from "./ComparisonView";
import { RunPanel, type DocStatus } from "./RunPanel";
import { tokens } from "@/lib/format";
import type { CatalogueDoc } from "@/lib/catalogue";
import { armsFor } from "@/lib/approaches";
import type { Presets } from "@/lib/presets";
import type { LeanDoc } from "@/lib/results";
import { indexModelOf, resultKey, type Manifest } from "@/lib/types";

/**
 * The fork, and the two things it forks into.
 *
 * The page has two audiences that want opposite things from the same screen. One
 * came to read a finding and wants the charts; the other wants to know whether the
 * finding is real, which means running it. Serving both at once produced a page
 * where the money button sat at the bottom of a demo, easy to miss and easy to
 * misread as part of the replay above it.
 *
 * So it is a choice, made once, and everything below it belongs to whichever branch
 * you took. A run ends by handing you its results, which is the only sequence that
 * makes sense: you did not run it to watch a progress grid.
 */

interface Props {
  manifest: Manifest | null;
  docs: LeanDoc[];
  catalogue: CatalogueDoc[];
  presets: Presets;
  /** Completeness per result set, keyed by `resultKey(doc, model)`. */
  status: Record<string, DocStatus>;
  /**
   * Cell keys (`arm::question`) that already have results, keyed by
   * `resultKey(doc, model)`.
   */
  measured: Record<string, string[]>;
}

type Stage = "choose" | "run" | "results";

export function Workbench({
  manifest,
  docs,
  catalogue,
  presets,
  status,
  measured,
}: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("choose");
  /** Which result set the results view should open on, after a run produced it. */
  const [resultsDoc, setResultsDoc] = useState<
    { docId: string; model: string } | undefined
  >();

  const hasResults = Boolean(manifest) && docs.length > 0;

  // A run rewrote results/, so the server components have to re-render before the
  // results view has anything to show. Refresh first, then switch: the results
  // branch guards on the data actually being there, so arriving early degrades to a
  // wait rather than an error.
  const finish = useCallback(
    (docId: string, model: string) => {
      setResultsDoc({ docId, model });
      router.refresh();
      setStage("results");
    },
    [router],
  );

  if (stage === "run") {
    return (
      <RunPanel
        catalogue={catalogue}
        presets={presets}
        status={status}
        initialDocId={resultsDoc?.docId}
        measured={measured}
        onComplete={finish}
        onRefresh={() => router.refresh()}
        onBack={() => setStage("choose")}
      />
    );
  }

  if (stage === "results") {
    if (!hasResults || !manifest) {
      return (
        <section className="space-y-3">
          <p className="text-sm leading-relaxed text-text-dim">
            Loading the results you just produced…
          </p>
          <button
            type="button"
            onClick={() => setStage("choose")}
            className="text-sm text-text-faint underline decoration-dotted hover:text-text-dim"
          >
            ← Back
          </button>
        </section>
      );
    }
    return (
      <ComparisonView
        manifest={manifest}
        docs={docs}
        catalogue={catalogue}
        initialDocId={resultsDoc?.docId}
        initialModel={resultsDoc?.model}
        onRunMore={() => setStage("run")}
        onBack={() => setStage("choose")}
      />
    );
  }

  return (
    <section aria-labelledby="fork-heading" className="space-y-4">
      <div className="max-w-3xl">
        <h2 id="fork-heading" className="text-base font-medium text-text">
          Now pick one
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-text-dim">
          Read the measurements this clone already has, or make your own. They are the
          same numbers either way — the charts do not know which run produced them.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setStage("run")}
          className="rounded-md border border-border bg-bg-raised p-4 text-left transition-colors hover:border-accent"
        >
          <span className="block text-sm font-medium text-text">
            Run the evals
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-text-dim">
            Pick a document and the approaches, see what it would cost, then watch it
            measure. Needs the Python pipeline and your own key, and it spends real
            money — you see the projection before anything runs.
          </span>
          <span className="mt-2 block text-xs text-text-faint">
            {catalogue.length
              ? `${catalogue.length} document${catalogue.length === 1 ? "" : "s"} ready · ${armsFor(presets).length} approaches`
              : "No documents fetched yet"}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setStage("results")}
          disabled={!hasResults}
          className="rounded-md border border-border bg-bg-raised p-4 text-left transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border"
        >
          <span className="block text-sm font-medium text-text">
            Load the results
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-text-dim">
            {hasResults
              ? "Browse the questions, watch the approaches answer side by side, and read the cost and accuracy charts. Spends nothing — every answer is replayed from disk."
              : "Nothing to load yet. results/ is generated, not committed, so a fresh clone has none of it until you run something."}
          </span>
          <span className="mt-2 block text-xs text-text-faint">
            {hasResults
              ? // One line per document, not per result set — and "partial" only
                // when no model has measured it completely.
                [...new Map(docs.map((d) => [d.doc_id, d])).values()]
                  .map((d) => {
                    const complete = docs.some(
                      (x) =>
                        x.doc_id === d.doc_id &&
                        status[resultKey(x.doc_id, x.model, indexModelOf(x))]
                          ?.state === "measured",
                    );
                    return `${d.domain} · ${tokens(d.tokens)} tokens${
                      complete ? "" : " · partial"
                    }`;
                  })
                  .join("   ")
              : "Empty"}
          </span>
        </button>
      </div>
    </section>
  );
}
