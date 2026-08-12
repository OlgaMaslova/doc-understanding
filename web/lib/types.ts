/**
 * Shapes of the committed JSON in results/. These mirror the dataclasses in
 * pipeline/docrace/, which are the source of truth — if they disagree, the
 * pipeline is right and this file is stale.
 */

/**
 * Six approaches, seven measured arms: caching is one approach run at both cache
 * lifetimes, because the TTL is the thing that breaks it.
 *
 * "Arm" is the pipeline's word and the JSON is keyed by it, so it stays in these
 * types. The UI says "approach"; `lib/approaches.ts` translates.
 */
export const ARM_IDS = [
  "full_context",
  "cached_context_5m",
  "cached_context_1h",
  "naive_rag",
  "hybrid_rag",
  "agentic",
  "extract",
] as const;

export type ArmId = (typeof ARM_IDS)[number];

export type QuestionType =
  | "needle"
  | "multi_hop"
  | "aggregation"
  | "global"
  | "absent";

export type GradeId =
  | "correct"
  | "partial"
  | "incorrect"
  | "hallucinated"
  | "correctly_refused";

export interface CostBreakdown {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  embed: number;
  rerank: number;
  total: number;
}

export interface UsageBreakdown {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  embed_tokens: number;
  rerank_tokens: number;
  calls: number;
}

export interface Question {
  id: string;
  doc_id: string;
  type: QuestionType;
  question: string;
  ground_truth: string;
  grading_notes: string;
  /**
   * The passage the reference answer rests on, verified verbatim against the
   * document by `check_questions.py`. Empty for `absent` questions, which have
   * nothing to quote.
   */
  quote: string;
  /** For `absent` questions: phrases confirmed *not* to appear in the document. */
  absent_terms: string[];
}

export interface Cell {
  arm: ArmId;
  doc_id: string;
  question_id: string;
  answer: string;
  /** [millisecond offset from request start, text fragment] */
  deltas: [number, string][];
  usage: UsageBreakdown;
  cost: CostBreakdown;
  latency_ms: number;
  ttft_ms: number;
  notes: Record<string, unknown>;
  grade: { grade: GradeId; rationale: string };
}

export interface FailedCell {
  error: string;
  arm: ArmId;
  question_id: string;
}

export interface ArmEconomics {
  /** Paid once, before the first query: indexing, extraction, one cache write. */
  fixed_cost_usd: number;
  indexing_cost_usd: number;
  /** One cache warm — what the chart's intercept assumes. */
  cache_write_cost_usd: number;
  /** Every warm actually paid during the run. Exceeds the above if the cache lapsed. */
  cache_write_total_usd: number;
  /** More than one means the cache expired mid-run and had to be warmed again. */
  cache_write_count: number;
  /**
   * Whether the cached prefix is shared across queries. True for the full-context
   * arms and the extraction arm, so their warm is a one-time cost. False for
   * agentic search, which starts a fresh conversation per question and therefore
   * pays its warm per query.
   */
  cache_write_shared: boolean;
  /** Queries that actually read from cache, rather than paying full input price. */
  cache_read_queries: number;
  /** Mean per-query cost, excluding anything paid once. */
  marginal_cost_usd: number;
  marginal_min_usd: number;
  marginal_max_usd: number;
  mean_latency_ms: number;
  median_latency_ms: number;
  max_latency_ms: number;
  /** Mean credit across this document's questions, 0–1. */
  score: number;
  score_by_type: Partial<Record<QuestionType, number>>;
  n: number;
}

export interface DocResults {
  doc_id: string;
  domain: string;
  title: string;
  source_url: string;
  provenance: string;
  license: string;
  tokens: number;
  chars: number;
  model: string;
  pricing_snapshot: string;
  computed_at: string;
  chunking: { chunk_tokens: number; overlap_tokens: number };
  fixed_costs: Record<ArmId, { usage: UsageBreakdown; cost: CostBreakdown }>;
  questions: Question[];
  economics: Partial<Record<ArmId, ArmEconomics>>;
  cells: Record<string, Cell | FailedCell>;
}

/**
 * Whether a document's matrix is complete.
 *
 * `partial` — measured, but not every arm x question cell has been run, so its
 * aggregates rest on few data points. `measured` — the full matrix.
 */
export type ProvenanceState = "partial" | "measured";

export interface Manifest {
  docs: {
    doc_id: string;
    domain: string;
    title: string;
    tokens: number;
    source_url: string;
    license: string;
    provenance: string;
    provenance_state: ProvenanceState;
    cells: number;
    cells_expected: number;
  }[];
  arms: {
    id: ArmId;
    label: string;
    short: string;
    wins: string;
    breaks: string;
    /** Non-null when this arm is one variant of an approach measured twice. */
    variant_of: string | null;
  }[];
  question_types: { id: QuestionType; label: string; why: string }[];
  grades: { id: GradeId; label: string; credit: string }[];
  credit: Record<GradeId, number>;
  model: string;
  pricing_snapshot: string;
  computed_at: string;
  /**
   * True when any document's matrix is incomplete.
   *
   * Derived from the per-document states rather than asserted — a scoped run
   * leaves an incomplete matrix, and the page has to say so rather than presenting
   * a two-cell aggregate as a result.
   */
  partial: boolean;
}

export function isFailed(cell: Cell | FailedCell): cell is FailedCell {
  return "error" in cell;
}

export function cellKey(arm: ArmId, questionId: string): string {
  return `${arm}::${questionId}`;
}
