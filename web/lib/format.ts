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
 * one strategy measured twice rather than two unrelated strategies.
 */
export const ARM_COLOR: Record<ArmId, string> = {
  full_context: "#e0533d",
  cached_context_5m: "#eb8368",
  cached_context_1h: "#f5b8a4",
  naive_rag: "#4a9ecb",
  hybrid_rag: "#1f6f97",
  agentic: "#8a6cc4",
  extract: "#3fa87a",
};

export const GRADE_COLOR: Record<GradeId, string> = {
  correct: "#3fa87a",
  correctly_refused: "#5bbf94",
  partial: "#d9a441",
  incorrect: "#a3564a",
  hallucinated: "#d1382a",
};

export const TYPE_ORDER: QuestionType[] = [
  "needle",
  "multi_hop",
  "aggregation",
  "global",
  "absent",
];
