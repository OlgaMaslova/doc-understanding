/**
 * Approach, question-type and question metadata that does not come from a run.
 *
 * The manifest carries all of this, but the manifest is written *by* a run — so on
 * a fresh clone the page could not name the approaches you were about to pick, or
 * say how many questions a document has, which is what the run flow has to tell you
 * before it spends anything. `docrace.presets` is the other source, and emits the
 * same shapes the manifest uses so one set of types covers both.
 *
 * Shelling out to Python to read two files is not free, so this is cached for the
 * process. It is static repo data: it changes when someone edits `questions.yaml` or
 * `ARM_META`, which in dev means a restart, and in a deployment never — a deployment
 * has no pipeline to ask, and gets an empty set.
 *
 * No answer key here. Questions carry id, type and prompt only; ground truth reaches
 * the browser through results, next to the graded answer it judged.
 */

import { runPipeline } from "./runner";
import { ARM_IDS, type ArmId, type Manifest } from "./types";

export interface PresetQuestion {
  id: string;
  type: string;
  question: string;
}

/** A model the arms may answer with — one entry per rate-card row. */
export interface PresetModel {
  id: string;
  label: string;
  /** Input-token capacity; a larger document cannot run full-context arms. */
  context_window: number | null;
  input_per_mtok: number;
  output_per_mtok: number;
  /**
   * The arms this model can actually run, which is not the same set for every
   * model: caching is measured at both lifetimes where a request may choose one,
   * and as a single provider-default arm where it may not. Offering a reader an
   * arm outside this list produces a run the pipeline refuses to price.
   */
  arms: ArmId[];
  default: boolean;
}

export interface Presets {
  /**
   * Every arm any model can run — same shape as `Manifest["arms"]`, from the same
   * `ARM_META`. This is the catalogue, not a runnable set: use `armsFor` to narrow
   * it to one model before showing it as a choice.
   */
  arms: Manifest["arms"];
  question_types: Manifest["question_types"];
  grades: Manifest["grades"];
  credit: Manifest["credit"];
  models: PresetModel[];
  /** Fixed whatever model is chosen — indexing and grading; see pricing.py. */
  index_model: string;
  judge_model: string;
  /** Questions by document id. */
  questions: Record<string, PresetQuestion[]>;
}

const EMPTY: Presets = {
  arms: [],
  question_types: [],
  grades: [],
  credit: {} as Manifest["credit"],
  models: [],
  index_model: "",
  judge_model: "",
  questions: {},
};

let cached: Presets | null = null;

export async function loadPresets(): Promise<Presets> {
  if (cached) return cached;

  let out = "";
  for await (const event of runPipeline("docrace.presets", ["--json"])) {
    if (event.event === "log") out += `${String(event.text)}\n`;
    // A missing pipeline is the normal state of a deployed copy, not an error to
    // propagate: the run flow is unavailable there for the same reason, so an empty
    // set degrades to "nothing to offer" rather than a broken page.
    if (event.event === "run_error") return EMPTY;
    if (event.event === "exit" && event.code !== 0) return EMPTY;
  }

  const start = out.indexOf("{");
  if (start === -1) return EMPTY;
  try {
    const parsed = JSON.parse(out.slice(start)) as Presets;
    cached = {
      arms: parsed.arms ?? [],
      question_types: parsed.question_types ?? [],
      grades: parsed.grades ?? [],
      credit: parsed.credit ?? ({} as Manifest["credit"]),
      // A model whose entry names no arms is one from a pipeline older than
      // per-model arm sets. Every arm is offered for it, which is what this app
      // did before the field existed — wrong for an auto-caching provider, but
      // the estimator still refuses those, so the worst case is the old behaviour
      // rather than a silently wrong run.
      models: (parsed.models ?? []).map((m) => ({
        ...m,
        arms: (m.arms ?? []).filter((a): a is ArmId =>
          (ARM_IDS as readonly string[]).includes(a),
        ),
      })),
      index_model: parsed.index_model ?? "",
      judge_model: parsed.judge_model ?? "",
      questions: parsed.questions ?? {},
    };
    return cached;
  } catch {
    return EMPTY;
  }
}

/** How many questions a run of this document would ask. Zero if unknown. */
export function questionCount(presets: Presets, docId: string): number {
  return presets.questions[docId]?.length ?? 0;
}
