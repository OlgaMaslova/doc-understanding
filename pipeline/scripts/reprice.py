"""Re-price committed results against the current rate card, without re-running.

A price change does not change what the models did — every cell already stores the
token counts it used, so its cost is a pure function of `usage` and
`data/pricing.json`. This script recomputes that function in place: cell costs,
the per-arm fixed costs, the derived economics, and the `pricing_snapshot` stamp.
Measurements (`answer`, `usage`, `latency_ms`, `grade`, `computed_at`) are left
exactly as they were, because nothing about them is a function of price.

The alternative — re-running precompute — would spend real money to reproduce
answers that are already on disk, and would produce *different* answers, mixing a
pricing correction with a fresh measurement. Use this whenever `pricing.json`
changes and the runs themselves are still current.

Pricing goes through the same `price()` and `derive_economics()` the pipeline
uses, so there is no second implementation of the cost model to drift.

    python -m scripts.reprice --dry-run    # show what would change
    python -m scripts.reprice              # write it

Each file is priced at the model *it* was measured with (from its own `model`
field), not at `DOCRACE_MODEL` — repricing is not a place to reinterpret which
model produced a result.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docrace import arms as arms_pkg  # noqa: E402
from docrace.paths import RESULTS  # noqa: E402
from docrace.precompute import (  # noqa: E402
    LEGACY_INDEX_MODEL,
    DocAssets,
    derive_economics,
    write_manifest,
)
from docrace.pricing import Usage, model_rates, price, snapshot_date  # noqa: E402
from docrace.questions import Question  # noqa: E402


def reprice(data: dict) -> dict:
    """Return `data` with every cost field recomputed from its stored usage."""
    model = data["model"]
    model_rates(model)  # fail loudly here rather than pricing at a fallback rate

    cells = data["cells"]
    for cell in cells.values():
        # Error cells never got as far as spending tokens; there is nothing to price.
        if "usage" not in cell:
            continue
        cell["cost"] = price(Usage(**cell["usage"]), model).to_dict()

    # Indexing may have run on a different model from the arms (see pricing.py),
    # so fixed usage is priced at the model *this file recorded*, never at this
    # process's. Repricing is a pure re-read of committed usage: taking the index
    # model from the environment would let `DOCRACE_MODEL=x scripts/reprice.py`
    # quietly restate every old result set's indexing bill in x's rates.
    #
    # Files written before indexing was selectable carry no `index_model` and were
    # all indexed with Opus, which is what the fallback asserts.
    index_model = data.get("index_model", LEGACY_INDEX_MODEL)
    model_rates(index_model)
    fixed_usage = {
        arm: Usage(**entry["usage"])
        for arm, entry in (data.get("fixed_costs") or {}).items()
        if entry.get("usage")
    }
    data["fixed_costs"] = {
        arm: {
            "usage": fixed_usage.get(arm, Usage()).to_dict(),
            "cost": price(fixed_usage.get(arm, Usage()), index_model).to_dict(),
        }
        for arm in arms_pkg.ARM_ORDER
    }

    # Economics are derived from the cell costs above, so they have to be rebuilt
    # rather than scaled: `marginal_cost_usd` nets out cache writes per arm, and
    # `fixed_cost_usd` adds one cache warm to the indexing cost.
    assets = DocAssets(
        doc_id=data["doc_id"],
        domain=data["domain"],
        text="",
        naive_index=None,
        contextual_index=None,
        extraction=None,
        fixed_usage=fixed_usage,
        index_model=index_model,
    )
    questions = [Question(**q) for q in data["questions"]]
    data["economics"] = derive_economics(cells, assets, questions)
    data["pricing_snapshot"] = snapshot_date()
    return data


def spend(data: dict) -> float:
    return sum(c["cost"]["total"] for c in data["cells"].values() if "cost" in c)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the change per result set without writing anything.",
    )
    args = ap.parse_args()

    paths = sorted(p for p in RESULTS.glob("*.json") if p.name != "manifest.json")
    if not paths:
        raise SystemExit(f"no result sets in {RESULTS}")

    changed = 0
    for path in paths:
        data = json.loads(path.read_text())
        before = spend(data)
        after = spend(reprice(data))
        delta = after - before
        # A file whose model's rates did not move reprices to the same numbers.
        # Reporting it as unchanged is the point: it confirms the recompute agrees
        # with what precompute wrote, rather than quietly rewriting it.
        mark = "unchanged" if abs(delta) < 5e-9 else f"${before:.4f} -> ${after:.4f}"
        pct = "" if abs(delta) < 5e-9 else f"  ({delta / before:+.1%})"
        print(f"  {path.name}: {mark}{pct}")
        if abs(delta) >= 5e-9:
            changed += 1
        if not args.dry_run:
            path.write_text(json.dumps(data, indent=2) + "\n")

    verb = "would reprice" if args.dry_run else "repriced"
    print(
        f"{verb} {len(paths)} result set(s) at the {snapshot_date()} rate card; "
        f"{changed} changed"
    )
    if not args.dry_run:
        write_manifest()


if __name__ == "__main__":
    main()
