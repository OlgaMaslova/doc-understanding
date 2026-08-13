/**
 * Fetching the answers, in the browser, from a file written at build time.
 *
 * The comparison used to arrive over Server-Sent Events, one recorded stream per
 * arm, replayed instantly. A static host has no route handler to stream from, so the
 * same content is written per result set by `scripts/build-replay.mjs` and fetched
 * once per document. Nothing about what the reader sees changes: the replay was
 * already instant, because animating a recording made the page look like it was
 * doing work it was not.
 *
 * Bundles are cached for the tab, so switching back to a document you have already
 * looked at costs nothing.
 */

import { replayUrl } from "./site";
import type { CostBreakdown, GradeId, UsageBreakdown } from "./types";

/** One measured cell, reduced to what a card shows. */
export interface ReplayCell {
  answer: string;
  latency_ms: number;
  ttft_ms: number;
  cost: CostBreakdown;
  usage: UsageBreakdown;
  grade: { grade: GradeId; rationale: string };
  notes: Record<string, unknown>;
}

export interface FailedReplayCell {
  error: string;
}

export interface ReplayBundle {
  doc_id: string;
  model: string;
  /** Keyed by `arm::question`, the same keys the results files use. */
  cells: Record<string, ReplayCell | FailedReplayCell>;
}

export function isFailedReplay(
  cell: ReplayCell | FailedReplayCell,
): cell is FailedReplayCell {
  return "error" in cell;
}

const cache = new Map<string, Promise<ReplayBundle>>();

/**
 * Load the bundle for one result set.
 *
 * `file` is the filename the manifest records for the set, which is also the name
 * the build script writes — so the browser never constructs a path out of a document
 * id and a model and hopes.
 */
export function loadReplay(file: string): Promise<ReplayBundle> {
  const hit = cache.get(file);
  if (hit) return hit;

  const pending = fetch(replayUrl(file))
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Could not load the recorded answers (${res.status})`);
      }
      return res.json() as Promise<ReplayBundle>;
    })
    // Never cache a failure: switching away and back should retry, not replay the
    // same error.
    .catch((cause) => {
      cache.delete(file);
      throw cause;
    });
  cache.set(file, pending);
  return pending;
}
