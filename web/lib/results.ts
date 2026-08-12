/**
 * Server-side access to the precomputed results.
 *
 * Replay mode is the whole reason the deployed site is cheap and instant: these
 * files are read from disk, never regenerated at request time.
 *
 * Reads are cached, but not for the process lifetime — a local run started from
 * the run panel rewrites these files underneath us, and a cache that outlived
 * that would show stale numbers next to a finished run log. `invalidate()` is
 * called when a run completes.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ArmId, Cell, DocResults, Manifest } from "./types";
import { cellKey, isFailed } from "./types";

export type LeanCell =
  | {
      cost: number;
      cache_write: number;
      latency_ms: number;
      ttft_ms: number;
      calls: number;
      grade: string;
      rationale: string;
    }
  | { error: string };

export type LeanDoc = Omit<DocResults, "cells"> & {
  cells: Record<string, LeanCell>;
};

const RESULTS_DIR = path.join(process.cwd(), "..", "results");

/**
 * Reads are cached per file, keyed by mtime and size, so a rewritten file is
 * re-read automatically on the next request. Nothing has to signal the change:
 * a run started from the run panel lives in a different module instance in dev
 * (route handlers and server components are bundled separately, so a cross-module
 * `invalidate()` cleared the wrong copy's cache), and a run started from the
 * terminal signals nothing at all. The stat is the source of truth either way.
 */
const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

/**
 * Drop cached reads immediately rather than waiting for the next stat.
 *
 * With mtime-keyed caching this is belt and braces — kept because it is free and
 * makes the run route's intent explicit.
 */
export function invalidate(): void {
  cache.clear();
}

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
    // results/ is generated, not committed — a fresh clone has none. A raw ENOENT
    // from deep inside a prerender is a terrible first five minutes with this
    // repo, so say what to run instead.
    throw new Error(
      `No results found at results/${file}.\n\n` +
        `results/ is generated, not committed. Produce it with:\n\n` +
        `  cd pipeline\n` +
        `  .venv/bin/python -m docrace.documents --meta-only   # free, counts tokens\n` +
        `  .venv/bin/python -m docrace.estimate               # what a run would cost\n` +
        `  .venv/bin/python -m docrace.precompute --doc arxiv-paper --limit 2 \\\n` +
        `      --arm naive_rag --arm cached_context_1h        # ~$0.42\n\n` +
        `Every number this site shows is measured; there is no synthetic mode.\n` +
        `See "Running it" in README.md.`,
      { cause },
    );
  }
}

export async function loadManifest(): Promise<Manifest> {
  return readJson<Manifest>("manifest.json");
}

/**
 * The manifest, or null when no run has happened yet.
 *
 * An empty `results/` is the expected state of a fresh clone, not a fault, and
 * throwing for it gives a red runtime-error overlay with a truncated stack — the
 * worst possible first thirty seconds with this repo. The page renders a first-run
 * screen instead.
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

export async function loadDoc(docId: string): Promise<DocResults> {
  // Guard against traversal: the id has to be one the manifest knows about.
  const manifest = await loadManifest();
  if (!manifest.docs.some((d) => d.doc_id === docId)) {
    throw new Error(`Unknown document: ${docId}`);
  }
  return readJson<DocResults>(`${docId}.json`);
}

export async function loadCell(
  docId: string,
  arm: ArmId,
  questionId: string,
): Promise<Cell | null> {
  const doc = await loadDoc(docId);
  const cell = doc.cells[cellKey(arm, questionId)];
  if (!cell || isFailed(cell)) return null;
  return cell;
}

/**
 * A document's results with the bulky per-cell fields removed.
 *
 * All three documents are shipped to the browser at once so switching between
 * them reorders the chart instantly — that reordering is the eight seconds the
 * whole demo exists for, and a server round-trip would put a stutter in the
 * middle of it. Answers and delta streams are the bulk of the payload and
 * neither is needed for that: the charts run on numbers, and the comparison cards
 * receive their text over SSE.
 */
export async function loadDocLean(docId: string): Promise<LeanDoc> {
  const doc = await loadDoc(docId);
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
        };
  }
  return { ...doc, cells };
}
