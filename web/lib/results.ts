/**
 * Build-time access to the committed results.
 *
 * These files are the site's entire data source. On this branch they are read once,
 * during `next build`, and everything they produce is baked into the export — which
 * is the whole reason the deployed site costs nothing to serve and cannot spend
 * anything: there is no request-time code left to spend it.
 *
 * Reads are still cached per file and keyed by mtime, so an edited result file is
 * picked up by `next dev` without a restart.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { DocResults, Manifest } from "./types";
import { isFailed } from "./types";

export type LeanCell =
  | {
      cost: number;
      cache_write: number;
      latency_ms: number;
      ttft_ms: number;
      calls: number;
      grade: string;
      rationale: string;
      /**
       * Whether the run produced anything to grade at all.
       *
       * A wrong answer and no answer are both marked incorrect, but they are
       * different failures — one model reasoned to the wrong place, the other
       * never arrived. Keeping them apart is what lets the page say which kind of
       * failure a model actually has.
       */
      answered: boolean;
      /** True when the run stopped because it hit its own tool-call ceiling. */
      capped: boolean;
    }
  | { error: string };

export type LeanDoc = Omit<DocResults, "cells"> & {
  cells: Record<string, LeanCell>;
};

const RESULTS_DIR = path.join(process.cwd(), "..", "results");

/**
 * Reads are cached per file, keyed by mtime and size, so a rewritten file is
 * re-read on the next render rather than needing a restart. Nothing has to signal
 * the change — a run happens in a terminal, in a clone of the repository, and
 * signals nothing at all. The stat is the source of truth.
 */
const cache = new Map<
  string,
  { mtimeMs: number; size: number; value: unknown }
>();

async function readJson<T>(file: string): Promise<T> {
  const full = path.join(RESULTS_DIR, file);
  try {
    const st = await stat(full);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.value as T;
    }
    const value = JSON.parse(await readFile(full, "utf8")) as T;
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch (cause) {
    // A file that exists but will not parse is a real bug, not a missing run.
    if (cause instanceof SyntaxError) throw cause;
    // On this branch the results are committed, so a missing file means a partial
    // checkout or a manifest that names a file nobody added — a broken build, not
    // an un-run clone. Say which, because the export will otherwise fail somewhere
    // deep inside a prerender.
    throw new Error(
      `No results found at results/${file}.\n\n` +
        `This branch builds a static site out of the committed measurements in\n` +
        `results/, so every file the manifest names has to be in the checkout.\n` +
        `Either the checkout is incomplete, or manifest.json names a result set\n` +
        `that was never committed.`,
      { cause },
    );
  }
}

export async function loadManifest(): Promise<Manifest> {
  return readJson<Manifest>("manifest.json");
}

/**
 * The manifest, or null when there is none.
 *
 * Kept tolerant even though this branch commits its results: the page renders a
 * pointer to the repository instead of throwing, which is a better failure than a
 * red overlay with a truncated prerender stack.
 *
 * Only a *missing* file returns null. A file that exists and will not parse is a
 * real bug and still throws, because silently treating corruption as "no data" is
 * how a broken run gets mistaken for an un-run one.
 */
export async function loadManifestIfPresent(): Promise<Manifest | null> {
  try {
    await readFile(path.join(RESULTS_DIR, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  return loadManifest();
}

/**
 * One (document, model) result set.
 *
 * Results are stored per model — measuring a document with a second model adds a
 * sibling file rather than replacing the first. Without `model`, the most
 * recently measured set for the document is returned, which is what "show me
 * this document" should mean when nobody named a model.
 */
export async function loadDoc(
  docId: string,
  model?: string,
): Promise<DocResults> {
  // Guard against traversal: the pair has to be one the manifest knows about,
  // and the filename read is the one the pipeline wrote into the manifest.
  const manifest = await loadManifest();
  const entries = manifest.docs.filter((d) => d.doc_id === docId);
  if (!entries.length) {
    throw new Error(`Unknown document: ${docId}`);
  }
  const entry = model
    ? entries.find((d) => d.model === model)
    : entries.reduce((a, b) => (a.computed_at >= b.computed_at ? a : b));
  if (!entry) {
    throw new Error(`No results for ${docId} measured with ${model}`);
  }
  return readJson<DocResults>(path.basename(entry.file));
}

/**
 * A document's results with the bulky per-cell fields removed.
 *
 * Every result set is shipped to the browser at once so switching between them
 * reorders the chart instantly — that reordering is the eight seconds the whole
 * demo exists for, and a fetch would put a stutter in the middle of it. Answers and
 * delta streams are the bulk of the payload and neither is needed for that: the
 * charts run on numbers, and the answers arrive in the replay bundle the comparison
 * fetches for whichever document is on screen.
 */
export async function loadDocLean(
  docId: string,
  model?: string,
): Promise<LeanDoc> {
  const doc = await loadDoc(docId, model);
  const cells: LeanDoc["cells"] = {};
  for (const [key, cell] of Object.entries(doc.cells)) {
    cells[key] = isFailed(cell)
      ? { error: cell.error }
      : {
          cost: cell.cost.total,
          cache_write: cell.cost.cache_write,
          latency_ms: cell.latency_ms,
          ttft_ms: cell.ttft_ms,
          calls: cell.usage.calls,
          grade: cell.grade.grade,
          rationale: cell.grade.rationale,
          answered: cell.answer.trim().length > 0,
          capped: cell.notes.hit_iteration_cap === true,
        };
  }
  return { ...doc, cells };
}
