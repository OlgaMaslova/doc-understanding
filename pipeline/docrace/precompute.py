"""Precompute every preset question x arm result, offline, once.

This is the single most important engineering decision in the project. The
deployed site serves committed JSON: instant, deterministic, and free to visit.
Without it, one post to the front page empties the account in an afternoon.

The run is resumable. Indexes, contextual prefixes, and extractions are cached on
disk under pipeline/.index-cache, and results already present in results/ are
skipped unless --force is passed, so a run interrupted halfway costs nothing to
resume.
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
import time
from dataclasses import dataclass
from typing import Any

from . import arms as arms_pkg
from .arms import (
    agentic,
    cached_context,
    extract,
    full_context,
    hybrid_rag,
    naive_rag,
)
from .arms.base import ArmResult
from .chunking import CHUNK_TOKENS, OVERLAP_TOKENS, chunk_document
from .contextual import build_contextual_chunks
from .documents import BY_ID, load_meta, load_text
from .grading import CREDIT, GRADE_META, grade_answer
from .paths import INDEX_CACHE, RESULTS
from .pricing import ARM_MODEL, Cost, Usage, price, snapshot_date
from .questions import Question, TYPE_META, load_questions
from .retrieval import Index


@dataclass
class DocAssets:
    """Everything the arms need for one document, built once per run."""

    doc_id: str
    domain: str
    text: str
    # None when the arm that needs it was not selected for this run. Accessing one
    # that was not built is a programming error, not a data condition, so the
    # accessors below fail loudly rather than returning something empty.
    naive_index: Index | None
    contextual_index: Index | None
    extraction: dict[str, Any] | None
    # Fixed costs paid before the first query. These are the y-intercepts on the
    # cost chart, and the reason arm 4 and arm 6 are not free.
    fixed_usage: dict[str, Usage]

    def fixed_cost(self, arm: str) -> Cost:
        return price(self.fixed_usage.get(arm, Usage()), ARM_MODEL)

    def require_naive_index(self) -> Index:
        if self.naive_index is None:
            raise RuntimeError("naive index was not built for this run")
        return self.naive_index

    def require_contextual_index(self) -> Index:
        if self.contextual_index is None:
            raise RuntimeError("contextual index was not built for this run")
        return self.contextual_index

    def require_extraction(self) -> dict[str, Any]:
        if self.extraction is None:
            raise RuntimeError("extraction was not built for this run")
        return self.extraction


def _cache_path(doc_id: str, name: str):
    INDEX_CACHE.mkdir(parents=True, exist_ok=True)
    return INDEX_CACHE / f"{doc_id}.{name}.pkl"


def _cached(doc_id: str, name: str, build, *, force: bool = False):
    path = _cache_path(doc_id, name)
    if path.exists() and not force:
        print(f"  {name}: cached")
        return pickle.loads(path.read_bytes())
    value = build()
    path.write_bytes(pickle.dumps(value))
    return value


def _progress(label: str):
    def report(done: int, total: int) -> None:
        pct = int(100 * done / total) if total else 100
        sys.stdout.write(f"\r  {label}: {done}/{total} ({pct}%)")
        sys.stdout.flush()
        if done >= total:
            sys.stdout.write("\n")

    return report


def build_assets(
    doc_id: str, *, arms: list[str] | None = None, force: bool = False
) -> DocAssets:
    """Build only the assets the selected arms actually need.

    This gating is what makes a scoped run cheap. Arms 1, 2, and 5 need nothing
    but the document text, so `--arm full_context --arm cached_context_1h` should
    not pay for the contextual-prefix pass — which on the 10-K is over $7, several
    times the cost of the cells being run. Before this, `build_assets` ran in full
    regardless of `--arm`, and every scoped run silently overpaid.
    """
    selected = set(arms or arms_pkg.ARM_ORDER)
    source = BY_ID[doc_id]
    text = load_text(doc_id)
    meta = load_meta(doc_id)
    print(f"\n{doc_id}: {meta['tokens']:,} tokens, {meta['chars']:,} chars")

    naive_index: Index | None = None
    contextual_index: Index | None = None
    extraction: dict[str, Any] | None = None
    fixed_usage: dict[str, Usage] = {}

    needs_chunks = {naive_rag.ARM, hybrid_rag.ARM} & selected
    chunk_texts: list[str] = []
    if needs_chunks:
        chunk_texts = [c.text for c in chunk_document(text)]
        print(
            f"  chunks: {len(chunk_texts)} at ~{CHUNK_TOKENS} tokens, "
            f"{OVERLAP_TOKENS} overlap"
        )

    if naive_rag.ARM in selected:
        naive_index = _cached(
            doc_id, "naive-index", lambda: Index.build(chunk_texts), force=force
        )
        # Arm 3 pays only to embed the chunks.
        fixed_usage[naive_rag.ARM] = naive_index.build_usage

    if hybrid_rag.ARM in selected:

        def build_contextual() -> tuple[Index, Usage]:
            prefixed, usage = build_contextual_chunks(
                text, chunk_texts, progress=_progress("contextual prefixes")
            )
            return Index.build(prefixed), usage

        contextual_index, contextual_usage = _cached(
            doc_id, "contextual-index", build_contextual, force=force
        )
        # Arm 4 pays for the contextual prefixes plus embedding the prefixed
        # chunks — the real indexing bill, and it scales with document size.
        fixed_usage[hybrid_rag.ARM] = contextual_usage + contextual_index.build_usage

    if extract.ARM in selected:
        extraction, extraction_usage = _cached(
            doc_id,
            "extraction",
            lambda: extract.build_extraction(
                text, source.domain, progress=_progress("extraction windows")
            ),
            force=force,
        )
        # Arm 6 pays for one map-reduce pass over the whole document.
        fixed_usage[extract.ARM] = extraction_usage

    skipped = sorted(
        {naive_rag.ARM, hybrid_rag.ARM, extract.ARM} - selected
    )
    if skipped:
        print(f"  skipped indexing for unselected arms: {', '.join(skipped)}")
    for arm, usage in fixed_usage.items():
        print(f"  fixed cost {arm}: ${price(usage, ARM_MODEL).total:.4f}")

    return DocAssets(
        doc_id=doc_id,
        domain=source.domain,
        text=text,
        naive_index=naive_index,
        contextual_index=contextual_index,
        extraction=extraction,
        fixed_usage=fixed_usage,
    )


def run_arm(arm: str, assets: DocAssets, q: Question) -> ArmResult:
    if arm == full_context.ARM:
        return full_context.run(
            doc_id=assets.doc_id,
            document=assets.text,
            question_id=q.id,
            question=q.question,
        )
    if arm in cached_context.ARMS.values():
        return cached_context.run(
            doc_id=assets.doc_id,
            document=assets.text,
            question_id=q.id,
            question=q.question,
            ttl=cached_context.ttl_for(arm),
        )
    if arm == naive_rag.ARM:
        return naive_rag.run(
            doc_id=assets.doc_id,
            index=assets.require_naive_index(),
            question_id=q.id,
            question=q.question,
        )
    if arm == hybrid_rag.ARM:
        return hybrid_rag.run(
            doc_id=assets.doc_id,
            index=assets.require_contextual_index(),
            question_id=q.id,
            question=q.question,
        )
    if arm == agentic.ARM:
        return agentic.run(
            doc_id=assets.doc_id,
            document=assets.text,
            question_id=q.id,
            question=q.question,
        )
    if arm == extract.ARM:
        return extract.run(
            doc_id=assets.doc_id,
            extraction=assets.require_extraction(),
            question_id=q.id,
            question=q.question,
        )
    raise ValueError(f"Unknown arm: {arm}")


def derive_economics(
    cells: dict[str, Any], assets: DocAssets, questions: list[Question]
) -> dict[str, Any]:
    """Per-arm fixed and marginal cost, latency, and score.

    The split between fixed and marginal is what the cost chart plots: a fixed
    cost is the y-intercept, a marginal cost is the slope. Getting it right is
    what makes the crossover visible rather than a claim.

    Whether a cache write is fixed or marginal depends on whether the cached
    prefix is shared across queries. For the full-context arms and arm 6 it is —
    the document and the extracted record are identical for every question — so
    warming the cache is paid once and belongs in the intercept. For arm 5 it is
    not: each question starts a fresh conversation, so that arm warms its own
    cache every time and the write belongs in the slope. Treating every write as
    fixed would make agentic search look far cheaper per query than it is.
    """
    out: dict[str, Any] = {}
    for arm in arms_pkg.ARM_ORDER:
        rows = [
            c
            for key, c in cells.items()
            if key.startswith(f"{arm}::") and "cost" in c
        ]
        if not rows:
            continue

        write_shared = arm in arms_pkg.ARM_CACHE_SHARED_ACROSS_QUERIES
        marginal = sorted(
            c["cost"]["total"] - (c["cost"]["cache_write"] if write_shared else 0.0)
            for c in rows
        )
        latencies = sorted(c["latency_ms"] for c in rows)
        write_costs = [c["cost"]["cache_write"] for c in rows]
        writes = [w for w in write_costs if w > 0]
        # Only a shared cache contributes a warm to the intercept.
        intercept_write = max(write_costs, default=0.0) if write_shared else 0.0

        credits = [
            CREDIT.get(c.get("grade", {}).get("grade", "incorrect"), 0.0) for c in rows
        ]

        by_type: dict[str, list[float]] = {}
        q_type = {q.id: q.type for q in questions}
        for c in rows:
            t = q_type.get(c["question_id"])
            if t:
                by_type.setdefault(t, []).append(
                    CREDIT.get(c.get("grade", {}).get("grade", "incorrect"), 0.0)
                )

        mean = lambda xs: sum(xs) / len(xs)  # noqa: E731
        median = lambda xs: xs[len(xs) // 2]  # noqa: E731

        out[arm] = {
            # The chart's intercept is the steady-state model: indexing, plus one
            # cache warm. `cache_write_count` is what says whether that model held
            # — more than one write means the cache lapsed during the run and the
            # real spend was higher than the intercept implies. That is the whole
            # point of measuring the 5-minute variant, so it must not be averaged
            # away or silently dropped.
            "fixed_cost_usd": round(assets.fixed_cost(arm).total + intercept_write, 8),
            "indexing_cost_usd": round(assets.fixed_cost(arm).total, 8),
            "cache_write_cost_usd": round(intercept_write, 8),
            "cache_write_total_usd": round(sum(write_costs), 8),
            "cache_write_count": len(writes),
            "cache_write_shared": write_shared,
            "cache_read_queries": sum(
                1 for c in rows if c["usage"]["cache_read_tokens"] > 0
            ),
            "marginal_cost_usd": round(mean(marginal), 8),
            "marginal_min_usd": round(marginal[0], 8),
            "marginal_max_usd": round(marginal[-1], 8),
            "mean_latency_ms": int(mean(latencies)),
            "median_latency_ms": int(median(latencies)),
            "max_latency_ms": latencies[-1],
            "score": round(mean(credits), 4),
            "score_by_type": {t: round(mean(v), 4) for t, v in by_type.items()},
            "n": len(rows),
        }
    return out


def results_path(doc_id: str):
    RESULTS.mkdir(parents=True, exist_ok=True)
    return RESULTS / f"{doc_id}.json"


def load_existing(doc_id: str) -> dict[str, Any]:
    path = results_path(doc_id)
    if path.exists():
        return json.loads(path.read_text())
    return {}


def write_results(doc_id: str, payload: dict[str, Any]) -> None:
    results_path(doc_id).write_text(json.dumps(payload, indent=2) + "\n")


def precompute_doc(
    doc_id: str,
    *,
    only_arms: list[str] | None,
    only_questions: list[str] | None,
    limit: int | None,
    force: bool,
    rebuild_index: bool,
) -> None:
    selected_arms = only_arms or list(arms_pkg.ARM_ORDER)
    for arm in selected_arms:
        if arm not in arms_pkg.ARM_ORDER:
            raise SystemExit(
                f"Unknown arm {arm!r}. Known: {', '.join(arms_pkg.ARM_ORDER)}"
            )
    assets = build_assets(doc_id, arms=selected_arms, force=rebuild_index)
    all_questions = load_questions(doc_id)
    questions = all_questions
    if only_questions:
        questions = [q for q in questions if q.id in only_questions]
    if limit is not None:
        # Applied after --question so the two compose predictably.
        questions = questions[:limit]
    if not questions:
        raise SystemExit(f"{doc_id}: no questions selected")

    existing = load_existing(doc_id)
    cells: dict[str, Any] = existing.get("cells", {})

    # A scoped run does not rebuild indexes for unselected arms, so their fixed
    # usage is absent from `assets`. Carry forward whatever a previous run
    # recorded, or the economics for arms whose cells are still on disk would be
    # rewritten with an indexing cost of zero — silently turning arm 4 from the
    # most expensive arm to index into a free one.
    for arm, entry in (existing.get("fixed_costs") or {}).items():
        if arm not in assets.fixed_usage and entry.get("usage"):
            assets.fixed_usage[arm] = Usage(**entry["usage"])
    meta = load_meta(doc_id)
    source = BY_ID[doc_id]

    # Arms are the outer loop so the cached arm's questions run back to back
    # within one cache lifetime, and so arm 1's uncached numbers are recorded
    # before arm 2 writes a cache entry over the same tokens.
    for arm in selected_arms:
        for q in questions:
            key = f"{arm}::{q.id}"
            if key in cells and not force:
                continue
            label = f"{arm} / {q.id} ({q.type})"
            print(f"  running {label} ... ", end="", flush=True)
            started = time.perf_counter()
            try:
                result = run_arm(arm, assets, q)
            except Exception as exc:  # noqa: BLE001 — one cell must not sink the run
                print(f"FAILED after {time.perf_counter() - started:.1f}s: {exc}")
                cells[key] = {"error": str(exc), "arm": arm, "question_id": q.id}
                write_results(doc_id, {**existing, "cells": cells})
                continue

            grade = grade_answer(q, result.answer)
            cell = result.to_dict()
            cell["grade"] = grade.to_dict()
            cells[key] = cell
            print(
                f"{result.latency_ms / 1000:.1f}s, "
                f"${result.cost.total:.4f}, {grade.grade}"
            )
            # Write after every cell so an interrupted run loses at most one.
            existing = {**existing, "cells": cells}
            write_results(doc_id, existing)

    payload = {
        "doc_id": doc_id,
        "domain": source.domain,
        "title": meta.get("title", source.title),
        "source_url": meta.get("url", source.url),
        "provenance": meta.get("provenance", source.provenance),
        "license": meta.get("license", source.license),
        "tokens": meta["tokens"],
        "chars": meta["chars"],
        "model": ARM_MODEL,
        "pricing_snapshot": snapshot_date(),
        "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        # Real measurements. The fixture generator writes True here, so the
        # provenance is unambiguous at the top of the file rather than only on
        # individual docs and cells.
        "fixture": False,
        "chunking": {"chunk_tokens": CHUNK_TOKENS, "overlap_tokens": OVERLAP_TOKENS},
        "fixed_costs": {
            arm: {
                "usage": assets.fixed_usage.get(arm, Usage()).to_dict(),
                "cost": assets.fixed_cost(arm).to_dict(),
            }
            for arm in arms_pkg.ARM_ORDER
        },
        "questions": [q.to_dict() for q in all_questions],
        "economics": derive_economics(cells, assets, all_questions),
        "cells": cells,
    }
    write_results(doc_id, payload)

    spend = sum(
        c.get("cost", {}).get("total", 0.0) for c in cells.values() if "cost" in c
    )
    fixed = sum(assets.fixed_cost(a).total for a in arms_pkg.ARM_ORDER)
    print(
        f"  {doc_id} done: {len(cells)} cells, "
        f"${spend:.2f} in queries + ${fixed:.2f} in indexing"
    )


def write_manifest() -> None:
    """One small file the web app reads first, listing docs in token order."""
    docs = []
    for path in sorted(RESULTS.glob("*.json")):
        if path.name == "manifest.json":
            continue
        data = json.loads(path.read_text())
        docs.append(
            {
                "doc_id": data["doc_id"],
                "domain": data["domain"],
                "title": data["title"],
                "tokens": data["tokens"],
                "source_url": data.get("source_url", ""),
                "license": data.get("license", ""),
                "provenance": data.get("provenance", ""),
            }
        )
    docs.sort(key=lambda d: d["tokens"])
    manifest = {
        "docs": docs,
        "arms": [
            {
                "id": arm,
                **arms_pkg.ARM_META[arm],
                # Set when this arm is one variant of a strategy measured more than
                # once — the two cache lifetimes — so the UI can present six
                # strategies without pretending they are one measurement.
                "variant_of": arms_pkg.ARM_VARIANT_GROUP.get(arm),
            }
            for arm in arms_pkg.ARM_ORDER
        ],
        "question_types": [
            {"id": t, **TYPE_META[t]} for t in TYPE_META
        ],
        "grades": [{"id": g, **GRADE_META[g]} for g in GRADE_META],
        "credit": CREDIT,
        "model": ARM_MODEL,
        "pricing_snapshot": snapshot_date(),
        "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        # Real measurements. The fixture generator writes True here, so the
        # provenance is unambiguous at the top of the file rather than only on
        # individual docs and cells.
        "fixture": False,
    }
    (RESULTS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest: {len(docs)} document(s)")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Precompute DocRace results. Resumable; skips completed cells."
    )
    ap.add_argument("--doc", action="append", help="Doc id; repeatable. Default: all.")
    ap.add_argument("--arm", action="append", help="Arm id; repeatable. Default: all.")
    ap.add_argument(
        "--question", action="append", help="Question id; repeatable. Default: all."
    )
    ap.add_argument(
        "--limit",
        type=int,
        help=(
            "Run only the first N questions per document. The cheapest way to "
            "verify a real run end to end; use at least 2 so the cached arms have "
            "a second query to read the cache on."
        ),
    )
    ap.add_argument(
        "--force", action="store_true", help="Re-run cells that already have results."
    )
    ap.add_argument(
        "--rebuild-index",
        action="store_true",
        help="Rebuild indexes, contextual prefixes, and extractions (costs money).",
    )
    ap.add_argument(
        "--manifest-only", action="store_true", help="Only regenerate the manifest."
    )
    args = ap.parse_args()

    if args.manifest_only:
        write_manifest()
        return

    doc_ids = args.doc or [s.doc_id for s in BY_ID.values()]
    for doc_id in doc_ids:
        if doc_id not in BY_ID:
            raise SystemExit(f"Unknown doc id {doc_id!r}. Known: {', '.join(BY_ID)}")
        precompute_doc(
            doc_id,
            only_arms=args.arm,
            only_questions=args.question,
            limit=args.limit,
            force=args.force,
            rebuild_index=args.rebuild_index,
        )

    write_manifest()


if __name__ == "__main__":
    main()
