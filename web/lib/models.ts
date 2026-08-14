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
  rows: ApproachRow[];
  /** Per model, over the rows every model ran. */
  summary: Record<string, ModelSummary>;
  /** The comparable row where the models' scores diverge most. */
  widestGap: ApproachRow | null;
  /**
   * The widest score gap among the *other* comparable rows.
   *
   * One approach diverging is a different claim from all of them diverging, and an
   * overall average states neither. This is what lets the page say "every other
   * approach is within n points" as a measurement rather than an impression.
   */
  gapExcludingWidest: number | null;
  /** How much cheaper the cheapest model is than the dearest, per query, overall. */
  costRatio: number;
  /** Cheapest and dearest by overall per-query cost. */
  cheapest: string;
  dearest: string;
}

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

  const rows: ApproachRow[] = [];
  for (const approach of groupApproaches(manifest.arms)) {
    const byModel: Record<string, ModelCell> = {};
    for (const model of models) {
      const scores: number[] = [];
      const costs: number[] = [];
      const fixed: number[] = [];
      const arms = new Set<ArmId>();
      let n = 0;
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
        };
      }
    }

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
    (worst, row) => ((row.scoreGap ?? 0) > (worst?.scoreGap ?? 0) ? row : worst),
    null as ApproachRow | null,
  );
  const others = comparable.filter((r) => r !== widestGap);
  const gapExcludingWidest = others.length
    ? Math.max(...others.map((r) => r.scoreGap ?? 0))
    : null;

  const questions = docIds.reduce(
    (total, docId) => total + (resultFor(docId, models[0])?.questions.length ?? 0),
    0,
  );

  return {
    models,
    docIds,
    questions,
    rows,
    summary,
    widestGap,
    gapExcludingWidest,
    costRatio: summary[dearest].perQueryUsd / summary[cheapest].perQueryUsd,
    cheapest,
    dearest,
  };
}
