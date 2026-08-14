"""The static metadata the web app needs before any results exist.

Everything the UI knew about approaches, question types and questions used to reach
it through `results/manifest.json` — which is written by a run. That was fine while
the site was replay-only: no results meant nothing to show, so nothing needed
describing. It stopped being fine when the run flow moved into the browser, because
now the page has to describe a run *before* the first one: name the approaches each
model can run so you can pick some, and count the questions so it can tell you what
it will cost.

A fresh clone has no manifest, so this module is the other source. Same values, same
shapes as the corresponding manifest fields — deliberately, so the browser can use
one type for both and the two cannot drift into disagreeing about what an approach
is called.

Emits no answer key. Questions carry their id, type and prompt; `ground_truth`,
`grading_notes`, `quote` and `absent_terms` stay out. Those reach the browser only
through results, next to the graded answer they were used to judge — which is how a
reader checks a grade, and not the same thing as printing the answers underneath the
questions of a document nobody has run yet.

    python -m docrace.presets            # everything
    python -m docrace.presets --doc form-10k
"""

from __future__ import annotations

import argparse
import json

from . import arms as arms_pkg
from .grading import CREDIT, GRADE_META, JUDGE_MODEL
from .pricing import DEFAULT_ARM_MODEL, INDEX_MODEL, pricing
from .questions import TYPE_META, load_questions


def presets(doc_id: str | None = None) -> dict:
    by_doc: dict[str, list[dict[str, str]]] = {}
    for q in load_questions(doc_id):
        by_doc.setdefault(q.doc_id, []).append(
            {"id": q.id, "type": q.type, "question": q.question}
        )

    return {
        # Every arm any model can run, not just this process's set. The run panel
        # has to name the approaches for whichever model is picked in the browser,
        # and the arm set depends on that model — see `arms.arms_for`. Which of
        # these a given model can actually run is on the model entries below;
        # anything describing "the approaches" generally should read the default
        # model's list rather than this whole catalogue, since the cached variants
        # in it are mutually exclusive.
        "arms": [
            {
                "id": arm,
                **arms_pkg.ARM_META[arm],
                "variant_of": arms_pkg.ARM_VARIANT_GROUP.get(arm),
            }
            for arm in arms_pkg.ALL_ARMS
        ],
        "question_types": [{"id": t, **TYPE_META[t]} for t in TYPE_META],
        "grades": [{"id": g, **GRADE_META[g]} for g in GRADE_META],
        "credit": CREDIT,
        # The models a run may answer with — every entry in the rate card, since
        # the rate card is exactly the set the pipeline can price. Indexing and
        # grading stay on fixed models whatever is chosen (see pricing.py), and
        # naming them here lets the UI say so instead of implying the whole
        # pipeline switches.
        #
        # Each carries its own arm set, because the cached-context arms a model has
        # depend on how its provider exposes caching: a request that gets to choose
        # a lifetime runs both TTL variants, a provider that caches on its own runs
        # the single `auto` variant. A UI offering one static list would let a
        # reader select an arm the chosen model cannot run, and the refusal would
        # arrive from the estimator, mid-flow, as a subprocess error.
        "models": [
            {
                "id": mid,
                "label": m.get("label", mid),
                "context_window": m.get("context_window"),
                "input_per_mtok": m["input_per_mtok"],
                "output_per_mtok": m["output_per_mtok"],
                "arms": list(arms_pkg.arms_for(mid)),
                "default": mid == DEFAULT_ARM_MODEL,
            }
            for mid, m in pricing()["models"].items()
        ],
        "index_model": INDEX_MODEL,
        "judge_model": JUDGE_MODEL,
        "questions": by_doc,
    }


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Print approach, question-type and question metadata as JSON."
    )
    ap.add_argument("--doc", help="Only this document's questions. Default: all.")
    ap.add_argument(
        "--json",
        action="store_true",
        help="Accepted for symmetry with the other modules; output is always JSON.",
    )
    args = ap.parse_args()
    print(json.dumps(presets(args.doc), indent=2))


if __name__ == "__main__":
    main()
