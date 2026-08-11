/**
 * Server-side access to the committed results.
 *
 * Replay mode is the whole reason the deployed site is cheap and instant: these
 * files are read from disk, never regenerated at request time. Reads are cached
 * for the process lifetime because the files are immutable between deploys.
 */

import { readFile } from "node:fs/promises";
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

const cache = new Map<string, unknown>();

async function readJson<T>(file: string): Promise<T> {
  const hit = cache.get(file);
  if (hit) return hit as T;
  let raw: string;
  try {
    raw = await readFile(path.join(RESULTS_DIR, file), "utf8");
  } catch (cause) {
    // results/ is generated, not committed — a fresh clone has none. A raw ENOENT
    // from deep inside a prerender is a terrible first five minutes with this
    // repo, so say what to run instead.
    throw new Error(
      `No results found at results/${file}.\n\n` +
        `results/ is generated, not committed. Populate it with either:\n` +
        `  cd pipeline && .venv/bin/python scripts/make_fixtures.py   # free, synthetic\n` +
        `  cd pipeline && .venv/bin/python -m docrace.precompute      # real, needs API keys\n\n` +
        `See "Running it" in README.md.`,
      { cause },
    );
  }
  const parsed = JSON.parse(raw) as T;
  cache.set(file, parsed);
  return parsed;
}

export async function loadManifest(): Promise<Manifest> {
  return readJson<Manifest>("manifest.json");
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
 * neither is needed for that: the charts run on numbers, and the race cards
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
