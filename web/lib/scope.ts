/**
 * Validation for a run scope.
 *
 * These values reach a subprocess argument list, so they are checked against
 * closed allowlists rather than sanitized. Nothing is passed through a shell —
 * `spawn` is given an argv array — but an id that merely *looks* wrong should be
 * rejected at the edge with a clear message rather than becoming a confusing
 * pipeline error several seconds later.
 */

import { ARM_IDS, type ArmId } from "./types";
import type { Scope } from "./runner";

/** Upper bound on questions per run from the UI; the full set is 15. */
export const MAX_LIMIT = 15;

export interface ScopeError {
  error: string;
}

export function parseScope(
  body: unknown,
  knownDocs: string[],
): Scope | ScopeError {
  if (typeof body !== "object" || body === null) {
    return { error: "Expected a JSON object with doc, arms and limit." };
  }
  const raw = body as Record<string, unknown>;

  const doc = raw.doc;
  if (typeof doc !== "string" || !knownDocs.includes(doc)) {
    return {
      error: `Unknown document ${JSON.stringify(doc)}. Known: ${knownDocs.join(", ")}.`,
    };
  }

  if (!Array.isArray(raw.arms) || raw.arms.length === 0) {
    return { error: "Select at least one arm." };
  }
  const arms: ArmId[] = [];
  for (const arm of raw.arms) {
    if (typeof arm !== "string" || !(ARM_IDS as readonly string[]).includes(arm)) {
      return {
        error: `Unknown arm ${JSON.stringify(arm)}. Known: ${ARM_IDS.join(", ")}.`,
      };
    }
    // Duplicates would double-count in the estimate and are always a mistake.
    if (!arms.includes(arm as ArmId)) arms.push(arm as ArmId);
  }

  const limit = raw.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    return { error: "limit must be a positive integer." };
  }
  if (limit > MAX_LIMIT) {
    return { error: `limit must be at most ${MAX_LIMIT}.` };
  }

  return { doc, arms, limit };
}

export function isScopeError(v: Scope | ScopeError): v is ScopeError {
  return "error" in v;
}
