/**
 * Validation for a run scope.
 *
 * These values reach a subprocess argument list, so they are checked against
 * closed allowlists rather than sanitized. Nothing is passed through a shell —
 * `spawn` is given an argv array — but an id that merely *looks* wrong should be
 * rejected at the edge with a clear message rather than becoming a confusing
 * pipeline error several seconds later.
 *
 * The document allowlist is the *catalogue*, not the manifest. A run's whole
 * purpose can be to measure a document for the first time, so restricting it to
 * documents that already have results would refuse every first run — the state a
 * fresh clone is entirely made of.
 */

import { ARM_IDS, type ArmId } from "./types";
import type { Scope } from "./runner";

export interface ScopeError {
  error: string;
}

/** A model a scope may name, and the arms it can run. From the presets dump. */
export interface KnownModel {
  id: string;
  arms: ArmId[];
}

export function parseScope(
  body: unknown,
  knownDocs: string[],
  knownModels: KnownModel[],
): Scope | ScopeError {
  if (typeof body !== "object" || body === null) {
    return { error: "Expected a JSON object with doc and arms." };
  }
  const raw = body as Record<string, unknown>;

  // The model reaches the subprocess as an environment variable, so it is checked
  // against the rate card's closed list like everything else — and the pipeline
  // re-validates on its side, so this is the polite refusal, not the boundary.
  const model = raw.model ?? knownModels[0]?.id;
  const known = knownModels.find((m) => m.id === model);
  if (typeof model !== "string" || !known) {
    return {
      error:
        `Unknown model ${JSON.stringify(raw.model)}. Known: ` +
        `${knownModels.map((m) => m.id).join(", ")}.`,
    };
  }

  // Defaults to the answering model rather than to a fixed one: a run that names
  // no index model is asking "what does this model cost me", and answering that
  // with someone else's rates in the fixed-cost line is the misreport this field
  // exists to end. Validated against the same closed list — it reaches the
  // subprocess environment exactly as the answering model does.
  const indexModel = raw.index_model ?? model;
  if (typeof indexModel !== "string" || !knownModels.some((m) => m.id === indexModel)) {
    return {
      error:
        `Unknown index model ${JSON.stringify(raw.index_model)}. Known: ` +
        `${knownModels.map((m) => m.id).join(", ")}.`,
    };
  }

  const doc = raw.doc;
  if (typeof doc !== "string" || !knownDocs.includes(doc)) {
    return {
      error: knownDocs.length
        ? `Unknown document ${JSON.stringify(doc)}. Known: ${knownDocs.join(", ")}.`
        : "No documents have been fetched yet. Run python -m docrace.documents first.",
    };
  }

  if (!Array.isArray(raw.arms) || raw.arms.length === 0) {
    return { error: "Select at least one approach." };
  }
  const arms: ArmId[] = [];
  for (const arm of raw.arms) {
    if (typeof arm !== "string" || !(ARM_IDS as readonly string[]).includes(arm)) {
      return {
        error: `Unknown arm ${JSON.stringify(arm)}. Known: ${ARM_IDS.join(", ")}.`,
      };
    }
    // A real arm, but not one this model has: the cached-context arms differ by
    // provider, so a selection made under one model can name an arm another cannot
    // run. The pipeline refuses these too — this is the refusal that can say which
    // model it was about, rather than an estimator exit code the browser relays.
    if (known.arms.length && !known.arms.includes(arm as ArmId)) {
      return {
        error:
          `${model} cannot run ${arm} — the cached-context approaches depend on how ` +
          `the provider exposes caching. It runs: ${known.arms.join(", ")}.`,
      };
    }
    // Duplicates would double-count in the estimate and are always a mistake.
    if (!arms.includes(arm as ArmId)) arms.push(arm as ArmId);
  }

  // Sent in canonical order rather than click order, so two identical selections
  // produce the same argv and the same cache behaviour.
  arms.sort((a, b) => ARM_IDS.indexOf(a) - ARM_IDS.indexOf(b));

  return { doc, arms, model, indexModel, force: raw.force === true };
}

export function isScopeError(v: Scope | ScopeError): v is ScopeError {
  return "error" in v;
}
