import type { ArmId, GradeId, QuestionType } from "./types";

/** Costs here span four orders of magnitude — a fixed precision hides the story. */
export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toExponential(1)}`;
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function seconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function tokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Categorical colours for the seven measured arms.
 *
 * The three full-context arms share one hue at three values, because they send
 * identical tokens and differ only in what those tokens cost. The palette should
 * say that before the copy does — and it makes the two cache lifetimes read as
 * one approach measured twice rather than two unrelated approaches.
 *
 * Every value here clears 4.5:1 against --bg-raised, because these are not only
 * fills: they colour the chart's 11px series labels, the "cheapest at" row, and
 * the arm named in the chart caption. The two retrieval blues are separated by
 * lightness rather than hue for the same reason — the accessible version of the
 * old #1f6f97 sat almost on top of naive RAG's blue, so naive RAG moved lighter
 * to keep the two series tellable apart in the chart. Both constraints bind: if
 * you retune these, check contrast *and* that no two arms collapse together.
 */
export const ARM_COLOR: Record<ArmId, string> = {
  full_context: "#e46b58",
  cached_context_5m: "#eb8368",
  cached_context_1h: "#f5b8a4",
  naive_rag: "#7cb9d9",
  hybrid_rag: "#2b99d0",
  agentic: "#9c83cd",
  extract: "#3fa87a",
};

/**
 * Grade colours. These are swatches — dots and ticks — not text, so they are held
 * to SC 1.4.11's 3:1 for meaningful non-text content rather than 4.5:1. The two
 * failing grades are deliberately the dark, muted end of the scale; `incorrect`
 * was lifted just enough to clear 3:1 on --bg-raised without becoming a second
 * `hallucinated` red.
 */
export const GRADE_COLOR: Record<GradeId, string> = {
  correct: "#3fa87a",
  correctly_refused: "#5bbf94",
  partial: "#d9a441",
  incorrect: "#ac5b4e",
  hallucinated: "#d1382a",
};

export const TYPE_ORDER: QuestionType[] = [
  "needle",
  "multi_hop",
  "aggregation",
  "global",
  "absent",
];
