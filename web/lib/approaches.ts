import type { Manifest } from "./types";

/**
 * An approach a reader is choosing between, plus the measured runs behind it.
 *
 * "Approach" is the user-facing word. The pipeline calls each measured run an
 * *arm* and the committed JSON is keyed that way, so the data-layer names below
 * stay `arms` — the vocabulary is translated at the edge, not in the schema.
 */
export interface Approach {
  /** `variant_of` for an approach measured more than once, else the arm's own id. */
  key: string;
  label: string;
  arms: Manifest["arms"];
}

/**
 * Collapse measured arms into the approaches a reader is actually choosing between.
 *
 * Prompt caching is not a retrieval approach — it is the full-context prompt at a
 * different price, measured at both cache lifetimes because the TTL is the thing
 * that breaks it. `variant_of` is how the pipeline says so, and grouping on it here
 * lets the page state "six approaches, seven measured runs" from the data. The
 * alternative is two hardcoded number words that go stale the moment an arm is
 * added, which is exactly the drift this file exists to prevent.
 */
export function groupApproaches(arms: Manifest["arms"]): Approach[] {
  const out: Approach[] = [];
  const byKey = new Map<string, Approach>();
  for (const arm of arms) {
    const key = arm.variant_of ?? arm.id;
    const existing = byKey.get(key);
    if (existing) {
      existing.arms.push(arm);
      continue;
    }
    const approach: Approach = { key, label: arm.label, arms: [arm] };
    byKey.set(key, approach);
    out.push(approach);
  }
  // A group's label comes from its first variant, which is labelled
  // "<approach> (<what varies>)" — "Full context + cache (5 min)". The approach is
  // the part before the parenthesis; keep the whole label if there isn't one.
  for (const approach of out) {
    if (approach.arms.length < 2) continue;
    const stripped = approach.label.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (stripped) approach.label = stripped;
  }
  return out;
}

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/**
 * Spell small counts, so copy derived from the manifest still reads as prose.
 * Anything larger falls back to digits rather than growing this table.
 */
export function numberWord(n: number): string {
  return WORDS[n] ?? String(n);
}
