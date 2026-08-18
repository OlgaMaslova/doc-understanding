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
from typing import Any, Iterable

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
from .pricing import (
    ARM_MODEL,
    INDEX_MODEL,
    Cost,
    Usage,
    cache_style_of,
    model_snapshot_date,
    price,
    snapshot_date,
)
from .questions import Question, TYPE_META, load_questions
from .retrieval import Index


# Result sets written before indexing became a choice carry no `index_model`, and
# every one of them was indexed with Opus, which was pinned at the time. The
# fallback is therefore a fact about those files rather than a guess — the same
# one `indexModelOf` applies on the web side.
LEGACY_INDEX_MODEL = "claude-opus-5"


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
    # Carried rather than read from the module so that anything rebuilding a
    # result set from disk — `scripts/reprice.py` — prices its indexing at the
    # model that actually wrote it, which is not necessarily this process's.
    index_model: str = INDEX_MODEL

    def fixed_cost(self, arm: str) -> Cost:
        # Indexing runs on INDEX_MODEL, which follows DOCRACE_MODEL unless it was
        # pinned (see pricing.py), so its usage is priced at that model's rates
        # rather than the arm model's. The two are the same by default and differ
        # only when someone deliberately held the index fixed across a comparison.
        return price(self.fixed_usage.get(arm, Usage()), self.index_model)

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



# ---------------------------------------------------------------------------
# Structured progress
#
# The web app spawns this module and needs to follow a run without scraping
# human-readable stdout. `--json` writes one JSON object per line to stderr,
# leaving stdout exactly as it was — so the CLI experience does not change and a
# parser never has to guess which lines are data.
# ---------------------------------------------------------------------------

_EMIT_JSON = False


def set_json_events(enabled: bool) -> None:
    global _EMIT_JSON
    _EMIT_JSON = enabled


def emit(kind: str, **fields: Any) -> None:
    if not _EMIT_JSON:
        return
    sys.stderr.write(json.dumps({"event": kind, **fields}) + "\n")
    sys.stderr.flush()


def _cache_path(doc_id: str, name: str, *, model: str | None = None):
    """Where a built index lives on disk.

    The model belongs in the key for anything an LLM wrote. Contextual prefixes
    and extraction records differ by the model that produced them, so a key of
    document alone would hand a DeepSeek run an index Opus wrote and report it as
    free — the artifact would be real, the provenance a fiction, and the fixed
    cost the run prints would belong to a different model.

    The naive index is the exception and stays unscoped: it is Voyage embeddings
    over raw chunks with no LLM in the path, so it is the same artifact whatever
    the index model is, and re-embedding per model would be paying for nothing.
    """
    INDEX_CACHE.mkdir(parents=True, exist_ok=True)
    stem = f"{doc_id}.{model}.{name}" if model else f"{doc_id}.{name}"
    return INDEX_CACHE / f"{stem}.pkl"


def _cached(doc_id: str, name: str, build, *, force: bool = False, model: str | None = None):
    path = _cache_path(doc_id, name, model=model)
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
    emit("doc_start", doc=doc_id, tokens=meta["tokens"], chars=meta["chars"])

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
                text,
                chunk_texts,
                doc_id=doc_id,
                progress=_progress("contextual prefixes"),
            )
            return Index.build(prefixed), usage

        contextual_index, contextual_usage = _cached(
            doc_id,
            "contextual-index",
            build_contextual,
            force=force,
            model=INDEX_MODEL,
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
            model=INDEX_MODEL,
        )
        # Arm 6 pays for one map-reduce pass over the whole document.
        fixed_usage[extract.ARM] = extraction_usage

    skipped = sorted(
        {naive_rag.ARM, hybrid_rag.ARM, extract.ARM} - selected
    )
    if skipped:
        print(f"  skipped indexing for unselected arms: {', '.join(skipped)}")
    for arm, usage in fixed_usage.items():
        cost = price(usage, INDEX_MODEL).total
        print(f"  fixed cost {arm}: ${cost:.4f}")
        emit("indexing_done", doc=doc_id, arm=arm, cost_usd=round(cost, 6))

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
    cells: dict[str, Any],
    assets: DocAssets,
    questions: list[Question],
    arms: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Per-arm fixed and marginal cost, latency, and score.

    `arms` defaults to this process's set, which is right for a live run. Anything
    rebuilding a result set from disk has to pass the arm set *that file* was
    measured with: the cached-context arms differ by provider, so deriving an
    open model's economics under Claude's arm order drops its `cached_context_auto`
    entry and invents two TTL variants its provider cannot run.

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
    for arm in arms if arms is not None else arms_pkg.ARM_ORDER:
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


def results_path(
    doc_id: str, model: str = ARM_MODEL, index_model: str | None = None
):
    """One file per distinct measurement: results/{doc_id}.{model}[.idx-{index}].json.

    The model is in the filename, not just the header, so measuring the same
    document with a second model produces a sibling file instead of a conflict
    with the first one's cells. The index model is the same argument one step
    further out: contextual retrieval and extract-then-query are downstream of it
    in *both* axes, so the same document answered by the same model over two
    different indexes is two result sets, not one, and merging them into a file
    with a single `index_model` header would make that header a lie about half
    the cells in it.

    The suffix appears only when indexing was pinned to something other than the
    answering model. A run where indexing follows — the default — writes the plain
    two-part name, because `{doc}.{model}.{model}.json` says nothing the shorter
    name does not, and the common path should not pay for the rare one.
    """
    RESULTS.mkdir(parents=True, exist_ok=True)
    index_model = index_model if index_model is not None else INDEX_MODEL
    suffix = "" if index_model == model else f".idx-{index_model}"
    return RESULTS / f"{doc_id}.{model}{suffix}.json"


def migrate_legacy_results() -> None:
    """Rename bare {doc_id}.json files to the per-model {doc_id}.{model}.json.

    Results used to be one file per document with the model only in the header,
    which is why a second model could not be measured without deleting the
    first. Old files carry real measurements, so they are renamed in place —
    the header already says which model they belong to.
    """
    for doc_id in BY_ID:
        legacy = RESULTS / f"{doc_id}.json"
        if not legacy.exists():
            continue
        model = json.loads(legacy.read_text()).get("model")
        if not model:
            raise SystemExit(
                f"results/{legacy.name} has no model header, so it cannot be "
                f"assigned a per-model filename. Fix or remove it."
            )
        target = results_path(doc_id, model)
        if target.exists():
            raise SystemExit(
                f"Both results/{legacy.name} and results/{target.name} claim "
                f"{model}. Merge or remove one of them."
            )
        legacy.rename(target)
        print(f"migrated results/{legacy.name} -> results/{target.name}")


def load_existing(doc_id: str) -> dict[str, Any]:
    """Prior results for this document and model, so a run resumes, not repeats."""
    path = results_path(doc_id)
    if not path.exists():
        return {}
    existing = json.loads(path.read_text())
    # Only reachable through a hand-renamed file: the filename and the header
    # disagree, and resuming would mix two configurations' cells. Checked for the
    # index model too, and with the same fallback the readers use — a file with no
    # `index_model` was written when indexing was pinned to Opus, so resuming one
    # under a different index model is exactly the mix this refuses.
    prior = existing.get("model")
    if prior and prior != ARM_MODEL:
        raise SystemExit(
            f"{doc_id}: results/{path.name} is named for {ARM_MODEL} but its "
            f"header says {prior!r}. Fix the filename or the header before running."
        )
    prior_index = existing.get("index_model", LEGACY_INDEX_MODEL)
    if prior_index != INDEX_MODEL:
        raise SystemExit(
            f"{doc_id}: results/{path.name} was indexed with {prior_index!r} but "
            f"this run indexes with {INDEX_MODEL!r}. Those are different "
            f"measurements on the contextual and extract approaches. Rename the "
            f"file to results/{results_path(doc_id, ARM_MODEL, prior_index).name} "
            f"if its header is right, or fix the header."
        )
    return existing


def write_results(doc_id: str, payload: dict[str, Any]) -> None:
    results_path(doc_id).write_text(json.dumps(payload, indent=2) + "\n")


def _is_done(cell: Any) -> bool:
    """Whether a stored cell is a result worth keeping.

    An error cell is a gap to fill, not a result: skipping it would make a
    crashed cell permanent, silently, until someone noticed the hole and
    reached for --force. Re-running the same scope retries errors by default
    and touches nothing that succeeded.
    """
    return isinstance(cell, dict) and "error" not in cell


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

    # Loaded once rather than per cell, to avoid re-reading the file.
    existing = load_existing(doc_id)
    cells: dict[str, Any] = existing.get("cells", {})

    pending = [
        (arm, q)
        for arm in selected_arms
        for q in questions
        if force or not _is_done(cells.get(f"{arm}::{q.id}"))
    ]
    emit(
        "doc_planned",
        doc=doc_id,
        arms=selected_arms,
        questions=[q.id for q in questions],
        cells_pending=len(pending),
    )

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
            if _is_done(cells.get(key)) and not force:
                continue
            label = f"{arm} / {q.id} ({q.type})"
            print(f"  running {label} ... ", end="", flush=True)
            emit("cell_start", doc=doc_id, arm=arm, question=q.id, type=q.type)
            started = time.perf_counter()
            try:
                result = run_arm(arm, assets, q)
            except Exception as exc:  # noqa: BLE001 — one cell must not sink the run
                print(f"FAILED after {time.perf_counter() - started:.1f}s: {exc}")
                emit("cell_error", doc=doc_id, arm=arm, question=q.id, error=str(exc))
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
            emit(
                "cell_done",
                doc=doc_id,
                arm=arm,
                question=q.id,
                latency_ms=result.latency_ms,
                cost_usd=round(result.cost.total, 6),
                grade=grade.grade,
                cache_read_tokens=result.usage.cache_read_tokens,
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
        # The model that wrote the contextual prefixes and the extraction record,
        # which is the answering model unless the run pinned it. Recorded because
        # arms 4 and 6 are downstream of it in both axes — a cheaper index model
        # is a cheaper y-intercept *and* a different set of retrieved chunks — so
        # two result sets that differ here are not comparable on those arms, and
        # nothing in the numbers themselves would tell a reader that.
        "index_model": INDEX_MODEL,
        # Recorded so the manifest and the UI can describe this matrix without
        # re-deriving the arm set from the model — see `arms_of`.
        "arms": list(arms_pkg.ARM_ORDER),
        "pricing_snapshot": model_snapshot_date(ARM_MODEL),
        "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
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

    # An arm that reads a cache it never wrote reports a $0 intercept, and $0 reads
    # as "warming this cache is free" rather than "this run did not measure it".
    # The usual cause is a still-live entry from an earlier run of the same arm —
    # re-run it outside the lifetime, or wait it out, to price the warm.
    #
    # Only meaningful where writes are a billable line item. On a provider that
    # caches automatically there is no write premium at all, so zero writes is the
    # correct and permanent state, and warning about it every run would train
    # people to ignore the warning that matters.
    warn_unmeasured_warm = cache_style_of(ARM_MODEL) == "explicit_ttl"
    for arm in arms_pkg.ARM_ORDER:
        e = payload["economics"].get(arm)
        if (
            warn_unmeasured_warm
            and arm in arms_pkg.ARM_CACHE_SHARED_ACROSS_QUERIES
            and e
            and e["cache_write_count"] == 0
        ):
            print(
                f"  warn  {arm}: {e['cache_read_queries']}/{e['n']} queries read a "
                "cache this run never wrote — its $0.00 fixed cost is unmeasured, "
                "not free"
            )



def arms_of(data: dict[str, Any]) -> list[str]:
    """Which arms one result set was measured with.

    Not `ARM_ORDER`: that is the arm set of whichever model the *current* process
    is configured for, and the manifest describes every file on disk. Reading it
    for all of them would judge a seven-arm Claude matrix against a six-arm open
    model's expectations, or vice versa, and mislabel complete matrices as partial.

    Runs record their own arm list. Files written before that did are resolved from
    the model in their header, which is what the rate card keys on anyway.
    """
    recorded = data.get("arms")
    if recorded:
        return list(recorded)
    try:
        return list(arms_pkg.arms_for(data.get("model") or ""))
    except KeyError:
        # A result set naming a model the rate card no longer carries. Its cells
        # are still real; fall back to the widest set so it reads as partial rather
        # than silently complete.
        return list(arms_pkg.ALL_ARMS)


def provenance_of(data: dict[str, Any], arms: int, questions: int) -> dict[str, Any]:
    """Whether one document's matrix is complete.

    Scoped runs make an incomplete matrix normal: two questions on one document
    leaves the rest unrun, and that document's accuracy and cost aggregates then
    rest on a couple of cells. Real but sparse is a different claim from real and
    complete, so each document says which it is and the UI repeats it.
    """
    # Error cells are pending retries, not measurements — counting them would
    # call a matrix with holes "measured" and the run panel would offer nothing
    # to fill them with.
    cells = [c for c in (data.get("cells") or {}).values() if _is_done(c)]
    expected = arms * questions
    return {
        "provenance_state": "measured" if cells and len(cells) >= expected else "partial",
        "cells": len(cells),
        "cells_expected": expected,
    }


def write_manifest() -> None:
    """One small file the web app reads first, listing result sets in token order.

    One entry per (document, model) pair — the same document measured with two
    models is two real result sets, and the manifest describes what is on disk.
    Each entry carries its filename, so nothing downstream has to reconstruct or
    parse the {doc_id}.{model}.json convention.
    """
    docs = []
    seen: set[tuple[str, str]] = set()
    # The union of every arm any result set on disk was measured with, so the UI
    # can describe a Claude file's cache-TTL rows and an open model's single
    # provider-default row from one manifest.
    #
    # Seeded empty, not from this run's ARM_ORDER: an arm no result set used has no
    # cells behind it, and listing it would have the UI draw a row that is
    # permanently blank. Describing arms before anything is measured is
    # `presets.py`'s job, and it reads the rate card directly.
    present_arms: set[str] = set()
    for path in sorted(RESULTS.glob("*.json")):
        if path.name == "manifest.json":
            continue
        data = json.loads(path.read_text())
        # Three parts, because two files can share a document and an answering
        # model and still be separate measurements — see `results_path`.
        pair = (
            data["doc_id"],
            data.get("model", ""),
            data.get("index_model", LEGACY_INDEX_MODEL),
        )
        if pair in seen:
            raise SystemExit(
                f"results/ holds more than one file for {pair[0]} measured with "
                f"{pair[1]} over a {pair[2]} index; results/{path.name} is the "
                f"duplicate. Merge or remove it."
            )
        seen.add(pair)
        questions = len(data.get("questions") or [])
        arms = arms_of(data)
        present_arms.update(arms)
        docs.append(
            {
                "doc_id": data["doc_id"],
                "domain": data["domain"],
                "title": data["title"],
                "tokens": data["tokens"],
                "source_url": data.get("source_url", ""),
                "license": data.get("license", ""),
                "provenance": data.get("provenance", ""),
                "model": data.get("model", ""),
                # Absent on result sets measured before indexing became a choice,
                # and every one of those was indexed with Opus. Defaulted here so
                # the UI reads one shape; see `indexModelOf` for the same fallback
                # on the reader's side.
                "index_model": data.get("index_model", LEGACY_INDEX_MODEL),
                # Per result set, because two files in the same manifest can have
                # different arm sets — see `arms_of`.
                "arms": arms,
                "file": path.name,
                "computed_at": data.get("computed_at", ""),
                **provenance_of(data, len(arms), questions),
            }
        )
    docs.sort(key=lambda d: (d["tokens"], d["doc_id"], d["model"], d["index_model"]))
    # One model reads as itself; a mix names every contributor.
    doc_models = sorted({d["model"] for d in docs if d["model"]})
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
            # Every arm any result set uses, not just this run's: the manifest has
            # to describe the files already on disk too.
            for arm in arms_pkg.ALL_ARMS
            if arm in present_arms
        ],
        "question_types": [
            {"id": t, **TYPE_META[t]} for t in TYPE_META
        ],
        "grades": [{"id": g, **GRADE_META[g]} for g in GRADE_META],
        "credit": CREDIT,
        "model": ", ".join(doc_models) if doc_models else ARM_MODEL,
        "pricing_snapshot": snapshot_date(),
        "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        # Derived, never asserted: a document is complete or it is not, and the
        # manifest reports what the files actually contain.
        "partial": any(d["provenance_state"] == "partial" for d in docs),
    }
    (RESULTS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest: {len(docs)} result set(s)")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=(
            "Precompute DocRace results. Resumable: completed cells are "
            "skipped, cells that errored are retried."
        )
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
        "--force",
        action="store_true",
        help="Re-run all selected cells, including ones with good results.",
    )
    ap.add_argument(
        "--rebuild-index",
        action="store_true",
        help="Rebuild indexes, contextual prefixes, and extractions (costs money).",
    )
    ap.add_argument(
        "--manifest-only", action="store_true", help="Only regenerate the manifest."
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help=(
            "Also write one JSON progress event per line to stderr. Used by the "
            "web app's run panel; stdout is unchanged."
        ),
    )
    args = ap.parse_args()
    set_json_events(args.json)

    # Results written before the per-model layout get their new names first, so
    # every path below — resume, manifest, a fresh run — sees one layout.
    migrate_legacy_results()

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
    emit("run_done")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        # SystemExit carries our own actionable messages. Mirror them as an event
        # so a consumer reading the event stream sees the reason rather than
        # inferring it from a non-zero exit code.
        if exc.code not in (0, None):
            emit("run_error", error=str(exc.code))
        raise
    except Exception as exc:  # noqa: BLE001 — surface then re-raise for the traceback
        emit("run_error", error=f"{type(exc).__name__}: {exc}")
        raise
