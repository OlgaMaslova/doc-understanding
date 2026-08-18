/**
 * Shapes of the committed JSON in results/. These mirror the dataclasses in
 * pipeline/docrace/, which are the source of truth — if they disagree, the
 * pipeline is right and this file is stale.
 */

/**
 * Every arm any model can run, in the pipeline's canonical order.
 *
 * Six approaches, seven measured arms on a model whose provider lets a request
 * choose a cache lifetime: caching is one approach run at both lifetimes, because
 * the TTL is the thing that breaks it. A provider that caches on its own runs
 * `cached_context_auto` in place of both, so no single run uses all eight ids —
 * the cached variants are mutually exclusive, and which ones a model has comes
 * from that model's own arm list in the presets dump.
 *
 * "Arm" is the pipeline's word and the JSON is keyed by it, so it stays in these
 * types. The UI says "approach"; `lib/approaches.ts` translates.
 */
export const ARM_IDS = [
  "full_context",
  "cached_context_5m",
  "cached_context_1h",
  "cached_context_auto",
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
  /**
   * The model that wrote the contextual prefixes and the extraction record. Equal
   * to `model` on a run that let indexing follow, which is the default.
   *
   * Optional because result sets measured before indexing became a choice have no
   * such field. Those were all indexed with claude-opus-5, which is what a reader
   * falling back should assume — see `indexModelOf`.
   */
  index_model?: string;
  pricing_snapshot: string;
  computed_at: string;
  chunking: { chunk_tokens: number; overlap_tokens: number };
  /**
   * Partial because a result set only holds the arms its model runs: the cached
   * variants are alternatives, so no file carries every id in `ARM_IDS`.
   */
  fixed_costs: Partial<
    Record<ArmId, { usage: UsageBreakdown; cost: CostBreakdown }>
  >;
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
  /**
   * One entry per (document, model) result set. The same document measured with
   * two models is two entries — results/ keeps one file per pair.
   */
  docs: {
    doc_id: string;
    domain: string;
    title: string;
    tokens: number;
    source_url: string;
    license: string;
    provenance: string;
    /** The model this result set was measured with. */
    model: string;
    /**
     * The model that built its contextual and extraction indexes. Equal to
     * `model` unless the run pinned it; defaulted by the writer for result sets
     * that predate the choice, so unlike `DocResults.index_model` this is always
     * present.
     */
    index_model: string;
    /**
     * The arms this result set holds. Per result set, not per manifest: the arm
     * a model measures caching with depends on its provider, so two files in one
     * manifest can have different sets and the union would have the results view
     * draw rows nothing was ever measured for.
     */
    arms: ArmId[];
    /** Filename of this result set inside results/, as written by the pipeline. */
    file: string;
    computed_at: string;
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

/**
 * Which model built this result set's indexes.
 *
 * Result sets written before indexing was selectable carry no `index_model`, and
 * every one of them was indexed with Opus — indexing was pinned to it. So the
 * fallback is a fact about those files, not a guess, and it is worth stating
 * rather than showing a blank: on arms 4 and 6 an Opus-indexed DeepSeek run and a
 * DeepSeek-indexed one differ in both cost and accuracy.
 */
export const LEGACY_INDEX_MODEL = "claude-opus-5";

export function indexModelOf(doc: {
  model: string;
  index_model?: string;
}): string {
  return doc.index_model ?? LEGACY_INDEX_MODEL;
}

export function isFailed(cell: Cell | FailedCell): cell is FailedCell {
  return "error" in cell;
}

export function cellKey(arm: ArmId, questionId: string): string {
  return `${arm}::${questionId}`;
}

/**
 * Key for one result set, mirroring the results/ layout.
 *
 * Three parts, not two. The same document answered by the same model over two
 * different indexes is two result sets — contextual retrieval and
 * extract-then-query differ in cost *and* in which chunks they retrieve — so a
 * two-part key would report one as already measured when the other was asked
 * for, and offer nothing to run.
 */
export function resultKey(
  docId: string,
  model: string,
  indexModel: string,
): string {
  return `${docId}::${model}::${indexModel}`;
}
