/**
 * Reading two models' result sets against each other.
 *
 * The page's original question was which *approach* to use. Once the same
 * documents have been measured with more than one answering model, a second
 * question sits underneath it: how much of what you pay is the approach, and how
 * much is the model. That one is only answerable because everything else was held
 * still — same documents, same questions, same answer key, same judge, same
 * indexing model — so the difference between two columns is the model and nothing
 * else.
 *
 * Everything here is derived from the committed result sets. Nothing names a model
 * or asserts a finding: which models appear, which is the expensive one, and
 * whether their accuracy actually is comparable are all read off the data, so a
 * re-run that overturns the conclusion changes the page instead of contradicting
 * it.
 */

import { groupApproaches } from "./approaches";
import type { LeanDoc } from "./results";
import type { ArmId, Manifest } from "./types";

/** One model's numbers for one approach, over the shared documents. */
export interface ModelCell {
  /** Mean credit, 0–1, weighted by the cells behind it. */
  score: number;
  /** Mean cost of one query, excluding anything paid once. */
  perQueryUsd: number;
  /** Paid before the first query: indexing, extraction, a cache warm. */
  fixedUsd: number;
  /** Which arms of this approach the model ran — two lifetimes, or one. */
  arms: ArmId[];
  /** Graded cells behind the score. */
  n: number;
  /**
   * Answers graded wrong outright — no credit at all. Partly-right answers are
   * not counted here: "got it wrong" should mean got it wrong.
   */
  wrong: number;
  /** Of `wrong`, the ones that never produced an answer to be wrong about. */
  unfinished: number;
}

export interface ApproachRow {
  key: string;
  label: string;
  /** Every arm behind the row, in manifest order — the first one carries its colour. */
  arms: ArmId[];
  /** Keyed by model id. Absent when the model never ran this approach. */
  byModel: Record<string, ModelCell>;
  /** Present only when every model ran it — the rows that compare. */
  complete: boolean;
  /** Dearest per-query cost divided by cheapest. Null unless `complete`. */
  costRatio: number | null;
  /** Highest score minus lowest, in credit. Null unless `complete`. */
  scoreGap: number | null;
  /**
   * What this approach's per-query cost did between the smallest and largest
   * shared document, as a multiple.
   *
   * The reason anyone picks an approach that loses on accuracy: some bills track
   * document size and some don't. Two documents of different sizes is a short
   * baseline for a slope, but it is a measured one, and it is the difference
   * between "this approach is worse" and "this approach is worse *here*".
   *
   * Null when the shared documents are all the same size, which is when the
   * question has no answer in this data.
   */
  costGrowth: number | null;
}

/**
 * The one approach where the models are not interchangeable, described in
 * questions rather than in score.
 *
 * A reader deciding between two models needs three things: whether it matters,
 * where it matters, and what going cheap actually costs there. A score gap states
 * none of them plainly — "18 points" is a number you have to convert before you
 * can act on it. These are the counts behind that gap, already converted.
 */
export interface Divergence {
  row: ApproachRow;
  /** The model that loses answers on this approach, and the one that doesn't. */
  weaker: string;
  stronger: string;
  /** Questions each gets wrong here, out of the shared question count. */
  weakerWrong: number;
  strongerWrong: number;
  /** How many of `weakerWrong` are the weaker model never finishing at all. */
  weakerUnfinished: number;
  /** The most extra questions the weaker model gets wrong on any *other* approach. */
  worstElsewhere: number;
  /**
   * How many *other* approaches also diverge by enough to matter.
   *
   * Zero is what makes "the model barely matters, except here" sayable. Any other
   * number and that sentence is false, so the page has to know the difference
   * rather than assume the shape it happened to be built against.
   */
  othersDiverging: number;
  /** Where the weaker model does best among the approaches that don't diverge. */
  refuge: ApproachRow | null;
  /**
   * Whether `refuge` is simply better than `row` at these document sizes — no
   * worse on answers and no dearer per question, for every model.
   *
   * When it is, the divergent approach is not a trade-off a reader is making on
   * purpose at this size, and the page can say so.
   */
  refugeDominates: boolean;
  /**
   * Whether `row`'s bill grows more slowly with document size than `refuge`'s.
   *
   * This is the reason anyone runs the divergent approach despite losing to the
   * refuge here: the refuge pays for the whole document on every query and this
   * one doesn't, so the ranking is a fact about these document sizes rather than
   * about the approaches. Not "the flattest of all" — chunk retrieval is flatter
   * still, and is not an alternative to it — only flatter than the thing that
   * currently beats it, which is the comparison a reader is actually making.
   */
  scalesFlatterThanRefuge: boolean;
}

export interface ModelSummary {
  model: string;
  /** Mean credit across the comparable rows. */
  score: number;
  /** Mean per-query cost across the comparable rows. */
  perQueryUsd: number;
}

export interface ModelComparison {
  /** Model ids, most expensive per query first — the baseline reads left. */
  models: string[];
  /** Documents every model has measured completely. The comparison's whole basis. */
  docIds: string[];
  /** Questions behind it, summed over those documents. */
  questions: number;
  /** Token counts of the smallest and largest shared document — the slope's base. */
  sizeSpan: { small: number; large: number } | null;
  rows: ApproachRow[];
  /** Per model, over the rows every model ran. */
  summary: Record<string, ModelSummary>;
  /** The comparable row where the models' scores diverge most. */
  widestGap: ApproachRow | null;
  /**
   * `widestGap` in plain counts, or null when no approach diverges enough to be
   * worth a reader's attention. Null is a finding too: it means pick on price.
   */
  divergence: Divergence | null;
  /** How much cheaper the cheapest model is than the dearest, per query, overall. */
  costRatio: number;
  /** Cheapest and dearest by overall per-query cost. */
  cheapest: string;
  dearest: string;
}

/**
 * A score gap this wide is the difference between the models, not noise.
 *
 * Lives here rather than in the component because it decides both what the page
 * highlights and whether there is a finding to state at all, and those two should
 * never be able to disagree.
 */
export const MATERIAL_GAP = 0.1;

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Line up every model that has measured the same documents completely.
 *
 * Returns null when there is nothing honest to show: fewer than two models, or no
 * document all of them finished. Partial result sets are excluded outright rather
 * than averaged in — a four-cell matrix has a score, and putting it in a column
 * next to a full one would invite exactly the misreading the rest of the page
 * spends its time preventing.
 */
export function compareModels(
  manifest: Manifest,
  docs: LeanDoc[],
): ModelComparison | null {
  // Completeness is the manifest's judgement, not this file's: it counts graded
  // cells against the arms each result set actually holds, which differ by model.
  const completeBy = new Map<string, Set<string>>();
  for (const entry of manifest.docs) {
    if (entry.provenance_state !== "measured") continue;
    const seen = completeBy.get(entry.model) ?? new Set<string>();
    seen.add(entry.doc_id);
    completeBy.set(entry.model, seen);
  }
  if (completeBy.size < 2) return null;

  const models = [...completeBy.keys()];
  const docIds = [...(completeBy.get(models[0]) ?? [])]
    .filter((id) => models.every((m) => completeBy.get(m)?.has(id)))
    .sort();
  if (!docIds.length) return null;

  const resultFor = (docId: string, model: string) =>
    docs.find((d) => d.doc_id === docId && d.model === model);

  // Document size is the axis the approaches actually differ on, so the shared
  // documents are ordered by it once, here, and every slope below reads off the
  // ends. Two points is a short baseline; it is also the only one the committed
  // data has, and the alternative is asserting the direction from first
  // principles instead of measuring it.
  const bySize = [...docIds].sort(
    (a, b) =>
      (resultFor(a, models[0])?.tokens ?? 0) -
      (resultFor(b, models[0])?.tokens ?? 0),
  );
  const smallest = bySize[0];
  const largest = bySize[bySize.length - 1];
  const smallTokens = resultFor(smallest, models[0])?.tokens ?? 0;
  const largeTokens = resultFor(largest, models[0])?.tokens ?? 0;
  const sizeSpan =
    largeTokens > smallTokens
      ? { small: smallTokens, large: largeTokens }
      : null;

  const rows: ApproachRow[] = [];
  for (const approach of groupApproaches(manifest.arms)) {
    const byModel: Record<string, ModelCell> = {};
    for (const model of models) {
      const scores: number[] = [];
      const costs: number[] = [];
      const fixed: number[] = [];
      const arms = new Set<ArmId>();
      let n = 0;
      let wrong = 0;
      let unfinished = 0;
      for (const docId of docIds) {
        const result = resultFor(docId, model);
        if (!result) continue;
        for (const arm of approach.arms) {
          const e = result.economics[arm.id];
          if (!e || !e.n) continue;
          arms.add(arm.id);
          scores.push(e.score);
          costs.push(e.marginal_cost_usd);
          fixed.push(e.fixed_cost_usd);
          n += e.n;
          // Counted off the graded cells rather than off the score, because a
          // mean of credit cannot say whether a model was wrong twice or half
          // right four times, and those are different things to buy.
          for (const [key, cell] of Object.entries(result.cells)) {
            if (key.split("::")[0] !== arm.id || "error" in cell) continue;
            if (cell.grade !== "incorrect" && cell.grade !== "hallucinated")
              continue;
            wrong += 1;
            if (!cell.answered || cell.capped) unfinished += 1;
          }
        }
      }
      // A mean of per-document means, not of every cell: each document contributes
      // the same weight whichever model ran it, and both models answered the same
      // question set, so the two columns stay comparable.
      if (scores.length) {
        byModel[model] = {
          score: mean(scores),
          perQueryUsd: mean(costs),
          fixedUsd: mean(fixed),
          arms: [...arms],
          n,
          wrong,
          unfinished,
        };
      }
    }

    // Averaged over the models, because the slope is a fact about the approach:
    // one model being dearer shifts both ends and leaves the ratio alone.
    const costAt = (docId: string) => {
      const values: number[] = [];
      for (const model of models) {
        const result = resultFor(docId, model);
        if (!result) continue;
        for (const arm of approach.arms) {
          const e = result.economics[arm.id];
          if (e && e.n) values.push(e.marginal_cost_usd);
        }
      }
      return values.length ? mean(values) : null;
    };
    const small = sizeSpan ? costAt(smallest) : null;
    const large = sizeSpan ? costAt(largest) : null;

    const cells = models.map((m) => byModel[m]).filter(Boolean);
    const complete = cells.length === models.length;
    rows.push({
      key: approach.key,
      label: approach.label,
      arms: approach.arms.map((a) => a.id),
      byModel,
      complete,
      costRatio: complete
        ? Math.max(...cells.map((c) => c.perQueryUsd)) /
          Math.min(...cells.map((c) => c.perQueryUsd))
        : null,
      scoreGap: complete
        ? Math.max(...cells.map((c) => c.score)) -
          Math.min(...cells.map((c) => c.score))
        : null,
      costGrowth: small && large ? large / small : null,
    });
  }

  const comparable = rows.filter((r) => r.complete);
  if (!comparable.length) return null;

  const summary: Record<string, ModelSummary> = {};
  for (const model of models) {
    summary[model] = {
      model,
      score: mean(comparable.map((r) => r.byModel[model].score)),
      perQueryUsd: mean(comparable.map((r) => r.byModel[model].perQueryUsd)),
    };
  }

  // Ordered by what they cost, not by name or by when they were run: the column
  // order is the comparison's argument, and it should not depend on a filename.
  models.sort((a, b) => summary[b].perQueryUsd - summary[a].perQueryUsd);

  const dearest = models[0];
  const cheapest = models[models.length - 1];
  const widestGap = comparable.reduce(
    (worst, row) =>
      (row.scoreGap ?? 0) > (worst?.scoreGap ?? 0) ? row : worst,
    null as ApproachRow | null,
  );

  const questions = docIds.reduce(
    (total, docId) =>
      total + (resultFor(docId, models[0])?.questions.length ?? 0),
    0,
  );

  // Cells, not questions, is what a column is counted over: a model with two cache
  // lifetimes answered the same questions twice. Scaling to the shared question
  // count is what makes "six of thirty" mean the same thing in both columns.
  const perQuestions = (cell: ModelCell, count: number) =>
    Math.round((count / cell.n) * questions);

  const divergence: Divergence | null = (() => {
    if (!widestGap || (widestGap.scoreGap ?? 0) < MATERIAL_GAP) return null;
    const ranked = [...models].sort(
      (a, b) => widestGap.byModel[a].score - widestGap.byModel[b].score,
    );
    const weaker = ranked[0];
    const stronger = ranked[ranked.length - 1];
    const others = comparable.filter((r) => r !== widestGap);
    const refuge = others.length
      ? others.reduce((best, row) => {
          const a = row.byModel[weaker];
          const b = best.byModel[weaker];
          if (a.score !== b.score) return a.score > b.score ? row : best;
          return a.perQueryUsd < b.perQueryUsd ? row : best;
        })
      : null;
    return {
      row: widestGap,
      weaker,
      stronger,
      weakerWrong: perQuestions(
        widestGap.byModel[weaker],
        widestGap.byModel[weaker].wrong,
      ),
      strongerWrong: perQuestions(
        widestGap.byModel[stronger],
        widestGap.byModel[stronger].wrong,
      ),
      weakerUnfinished: perQuestions(
        widestGap.byModel[weaker],
        widestGap.byModel[weaker].unfinished,
      ),
      othersDiverging: others.filter((r) => (r.scoreGap ?? 0) >= MATERIAL_GAP)
        .length,
      worstElsewhere: others.reduce((worst, row) => {
        const extra =
          perQuestions(row.byModel[weaker], row.byModel[weaker].wrong) -
          perQuestions(row.byModel[stronger], row.byModel[stronger].wrong);
        return Math.max(worst, extra);
      }, 0),
      // Where a reader who wanted the cheap model can still have it: the approach
      // the weaker model handles best among the ones that don't diverge. Ties go
      // to the cheaper of them, since a tie on answers is a decision about price.
      refuge,
      refugeDominates:
        refuge !== null &&
        models.every(
          (m) =>
            refuge.byModel[m].score >= widestGap.byModel[m].score &&
            refuge.byModel[m].perQueryUsd <= widestGap.byModel[m].perQueryUsd,
        ),
      scalesFlatterThanRefuge:
        refuge !== null &&
        refuge.costGrowth !== null &&
        widestGap.costGrowth !== null &&
        widestGap.costGrowth < refuge.costGrowth,
    };
  })();

  return {
    models,
    docIds,
    questions,
    sizeSpan,
    rows,
    summary,
    widestGap,
    divergence,
    costRatio: summary[dearest].perQueryUsd / summary[cheapest].perQueryUsd,
    cheapest,
    dearest,
  };
}
