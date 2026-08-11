#!/usr/bin/env python3
"""Generate plausible fake results so the web app can be built and reviewed
without spending anything.

This is a development aid, not part of the pipeline. It writes files with the
same shape as a real run into results/, so a real `docrace-precompute` run
overwrites them. Token counts and rates come from data/pricing.json, so the
relative economics between arms are honest even though the answers are not —
which is what makes the charts worth looking at before the real run.

Usage:  python scripts/make_fixtures.py
"""

from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docrace import arms as arms_pkg  # noqa: E402
from docrace.grading import CREDIT, GRADE_META  # noqa: E402
from docrace.paths import RESULTS  # noqa: E402
from docrace.pricing import ARM_MODEL, Usage, price, snapshot_date  # noqa: E402
from docrace.questions import TYPE_META, load_questions  # noqa: E402

random.seed(7)

DOCS = [
    ("arxiv-paper", "scientific", "A research paper (fixture)", 16_921),
    ("edgar-contract", "legal", "A material contract exhibit (fixture)", 40_674),
    ("form-10k", "financial", "An annual report on Form 10-K (fixture)", 173_140),
]

# How each arm tends to do per question type. Loosely modelled on the pattern the
# real run is expected to show, so the heatmap is worth reviewing: needle is a
# wall of green, and retrieval degrades on aggregation and absence.
SKILL = {
    "full_context": {"needle": 1.0, "multi_hop": 0.95, "aggregation": 0.9, "global": 0.95, "absent": 0.9},
    # Identical to full_context by construction: same prompt, so same accuracy.
    "cached_context_5m": {"needle": 1.0, "multi_hop": 0.95, "aggregation": 0.9, "global": 0.95, "absent": 0.9},
    "cached_context_1h": {"needle": 1.0, "multi_hop": 0.95, "aggregation": 0.9, "global": 0.95, "absent": 0.9},
    "naive_rag": {"needle": 0.95, "multi_hop": 0.4, "aggregation": 0.15, "global": 0.3, "absent": 0.2},
    "hybrid_rag": {"needle": 1.0, "multi_hop": 0.7, "aggregation": 0.35, "global": 0.6, "absent": 0.5},
    "agentic": {"needle": 0.95, "multi_hop": 0.9, "aggregation": 0.6, "global": 0.7, "absent": 0.75},
    "extract": {"needle": 0.85, "multi_hop": 0.7, "aggregation": 1.0, "global": 0.7, "absent": 0.6},
}

ANSWER = (
    "This is fixture text standing in for a real streamed answer. It exists so the "
    "race view, the cost chart, and the heatmap can be reviewed before any money is "
    "spent on the real precompute run."
)


def grade_for(arm: str, qtype: str) -> tuple[str, str]:
    p = SKILL[arm][qtype]
    roll = random.random()
    if qtype == "absent":
        if roll < p:
            return "correctly_refused", "Said the document does not address this."
        if roll < p + (1 - p) * 0.6:
            return "hallucinated", "Produced a specific figure the document does not contain."
        return "partial", "Hedged toward a specific claim while noting uncertainty."
    if roll < p:
        return "correct", "States the substance of the reference answer."
    if roll < p + (1 - p) * 0.5:
        return "partial", "Right in substance but omits a material part."
    return "incorrect", "Contradicts the reference answer."


def usage_for(arm: str, doc_tokens: int, first: bool, index: int = 0) -> Usage:
    out = random.randint(220, 700)
    if arm == "full_context":
        return Usage(input_tokens=doc_tokens + 120, output_tokens=out, calls=1)
    if arm.startswith("cached_context"):
        ttl = arm.rsplit("_", 1)[1]
        field = "cache_write_5m_tokens" if ttl == "5m" else "cache_write_1h_tokens"
        # The 5-minute variant is modelled as lapsing partway through the run, which
        # is the behaviour the variant exists to expose.
        rewrites = first or (ttl == "5m" and index and index % 7 == 0)
        if rewrites:
            return Usage(
                **{field: doc_tokens}, input_tokens=120, output_tokens=out, calls=1
            )
        return Usage(
            cache_read_tokens=doc_tokens, input_tokens=120, output_tokens=out, calls=1
        )
    if arm == "naive_rag":
        return Usage(input_tokens=2_900, output_tokens=out, embed_tokens=25, calls=1)
    if arm == "hybrid_rag":
        return Usage(
            input_tokens=3_600, output_tokens=out, embed_tokens=25, rerank_tokens=11_000, calls=1
        )
    if arm == "agentic":
        calls = random.randint(4, 12)
        # History grows each turn and the prefix reads from cache; only the new turn
        # is fresh. Modelling it as a flat per-call figure understates the arm.
        history, u = 600, Usage()
        for turn in range(calls):
            if turn == 0:
                u = u + Usage(input_tokens=history, cache_write_5m_tokens=history, calls=1)
            else:
                u = u + Usage(
                    cache_read_tokens=history - 2_000,
                    input_tokens=2_000,
                    cache_write_5m_tokens=2_000,
                    calls=1,
                )
            history += 2_000
        return u + Usage(output_tokens=out + 180 * calls)
    if arm == "extract":
        record = 4_000
        if first:
            return Usage(
                cache_write_1h_tokens=record, input_tokens=250, output_tokens=out, calls=1
            )
        return Usage(
            cache_read_tokens=record, input_tokens=250, output_tokens=out, calls=1
        )
    raise ValueError(arm)



def notes_for(arm: str, doc_tokens: int, usage: Usage, index: int) -> dict:
    """Per-arm notes shaped like the real ones.

    `{"fixture": true}` alone would leave the "How it got there" disclosure with
    nothing to show, so these mirror the keys each arm module actually records —
    same names, plausible values — and keep the fixture marker alongside.
    """
    chunks = max(1, doc_tokens // 450)
    pick = lambda n: sorted(random.sample(range(chunks), min(n, chunks)))
    base = {"fixture": True}
    if arm == "full_context":
        return {"context": "entire document, uncached", **base}
    if arm.startswith("cached_context"):
        ttl = arm.rsplit("_", 1)[1]
        return {
            "context": "entire document, cached",
            "cache_ttl": ttl,
            "cache_hit": usage.cache_read_tokens > 0,
            "cache_written": usage.cache_write_5m_tokens + usage.cache_write_1h_tokens > 0,
            **base,
        }
    if arm == "naive_rag":
        return {
            "retrieved_chunks": pick(5),
            "top_k": 5,
            "retrieval": "embedding cosine similarity, no reranking",
            **base,
        }
    if arm == "hybrid_rag":
        return {
            "retrieved_chunks": pick(5),
            "fused_candidates": pick(20),
            "fuse_k": 20,
            "top_k": 5,
            "retrieval": (
                "contextual prefixes, BM25 + embeddings fused by reciprocal rank, "
                "cross-encoder reranked"
            ),
            **base,
        }
    if arm == "agentic":
        tools = ["grep", "read_lines"]
        return {
            "tool_calls": [
                {"iteration": i, "tool": random.choice(tools)}
                for i in range(usage.calls)
            ],
            "iterations": usage.calls,
            "hit_iteration_cap": usage.calls >= 15,
            "retrieval": "model-driven grep and read over the raw document",
            "cache_ttl": "5m",
            "cache_breakpoints": 2,
            "cache_read_tokens": usage.cache_read_tokens,
            **base,
        }
    if arm == "extract":
        return {
            "context": "structured extraction only; document not available",
            "extraction_chars": 14_800,
            "cache_ttl": "1h",
            "cache_hit": usage.cache_read_tokens > 0,
            **base,
        }
    return base


def deltas_for(text: str, latency_ms: int, ttft_ms: int) -> list[list]:
    words = text.split(" ")
    span = max(latency_ms - ttft_ms, 1)
    out = []
    for i, w in enumerate(words):
        at = ttft_ms + int(span * (i + 1) / len(words))
        out.append([at, (" " if i else "") + w])
    return out


def latency_for(arm: str, doc_tokens: int) -> tuple[int, int]:
    base = {
        "full_context": 6_000 + doc_tokens // 40,
        "cached_context_5m": 3_500 + doc_tokens // 120,
        "cached_context_1h": 3_500 + doc_tokens // 120,
        "naive_rag": 3_000,
        "hybrid_rag": 4_200,
        "agentic": 22_000 + doc_tokens // 20,
        "extract": 2_600,
    }[arm]
    latency = int(base * random.uniform(0.85, 1.2))
    return latency, int(latency * random.uniform(0.25, 0.5))


def fixed_usage(arm: str, doc_tokens: int) -> Usage:
    chunks = max(1, doc_tokens // 450)
    if arm == "naive_rag":
        return Usage(embed_tokens=doc_tokens)
    if arm == "hybrid_rag":
        batches = max(1, chunks // 20)
        return Usage(
            cache_write_1h_tokens=doc_tokens,
            cache_read_tokens=doc_tokens * max(0, batches - 1),
            input_tokens=chunks * 520,
            output_tokens=chunks * 70,
            embed_tokens=int(doc_tokens * 1.4),
            calls=batches,
        )
    if arm == "extract":
        windows = max(1, doc_tokens // 30_000)
        return Usage(
            input_tokens=doc_tokens + 400 * windows,
            output_tokens=3_000 * windows,
            calls=windows + (1 if windows > 1 else 0),
        )
    return Usage()


def build_questions(doc_id: str) -> list[dict]:
    """The real questions from data/questions.yaml, not invented ones.

    The answers in a fixture run are synthetic, but there is no reason for the
    *answer key* to be. Using the committed questions means the reference answer,
    the verified evidence quote, and the absent-term lists are all real, so the
    answer-key panel can actually be reviewed — and a placeholder like
    "(fixture ground truth)" never reaches the UI pretending to be an answer.
    """
    return [q.to_dict() for q in load_questions(doc_id)]


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    for doc_id, domain, title, doc_tokens in DOCS:
        questions = build_questions(doc_id)
        cells: dict[str, dict] = {}
        fixed = {arm: fixed_usage(arm, doc_tokens) for arm in arms_pkg.ARM_ORDER}

        for arm in arms_pkg.ARM_ORDER:
            for i, q in enumerate(questions):
                usage = usage_for(arm, doc_tokens, first=(i == 0), index=i)
                cost = price(usage, ARM_MODEL)
                latency, ttft = latency_for(arm, doc_tokens)
                grade, rationale = grade_for(arm, q["type"])
                text = f"{ANSWER} [{arm} / {q['type']}]"
                cells[f"{arm}::{q['id']}"] = {
                    "arm": arm,
                    "doc_id": doc_id,
                    "question_id": q["id"],
                    "answer": text,
                    "deltas": deltas_for(text, latency, ttft),
                    "usage": usage.to_dict(),
                    "cost": cost.to_dict(),
                    "latency_ms": latency,
                    "ttft_ms": ttft,
                    "notes": notes_for(arm, doc_tokens, usage, i),
                    "grade": {"grade": grade, "rationale": rationale},
                }

        economics: dict[str, dict] = {}
        for arm in arms_pkg.ARM_ORDER:
            rows = [c for k, c in cells.items() if k.startswith(f"{arm}::")]
            shared_arm = arm in arms_pkg.ARM_CACHE_SHARED_ACROSS_QUERIES
            marginal = sorted(
                c["cost"]["total"] - (c["cost"]["cache_write"] if shared_arm else 0.0)
                for c in rows
            )
            lats = sorted(c["latency_ms"] for c in rows)
            writes = [c["cost"]["cache_write"] for c in rows]
            credits = [CREDIT[c["grade"]["grade"]] for c in rows]
            qtype = {q["id"]: q["type"] for q in questions}
            by_type: dict[str, list[float]] = {}
            for c in rows:
                by_type.setdefault(qtype[c["question_id"]], []).append(
                    CREDIT[c["grade"]["grade"]]
                )
            shared = arm in arms_pkg.ARM_CACHE_SHARED_ACROSS_QUERIES
            intercept_write = max(writes) if shared else 0.0
            economics[arm] = {
                "fixed_cost_usd": round(price(fixed[arm], ARM_MODEL).total + intercept_write, 8),
                "indexing_cost_usd": round(price(fixed[arm], ARM_MODEL).total, 8),
                "cache_write_cost_usd": round(intercept_write, 8),
                "cache_write_total_usd": round(sum(writes), 8),
                "cache_write_count": sum(1 for w in writes if w > 0),
                "cache_write_shared": shared,
                "cache_read_queries": sum(
                    1 for c in rows if c["usage"]["cache_read_tokens"] > 0
                ),
                "marginal_cost_usd": round(sum(marginal) / len(marginal), 8),
                "marginal_min_usd": round(marginal[0], 8),
                "marginal_max_usd": round(marginal[-1], 8),
                "mean_latency_ms": int(sum(lats) / len(lats)),
                "median_latency_ms": lats[len(lats) // 2],
                "max_latency_ms": lats[-1],
                "score": round(sum(credits) / len(credits), 4),
                "score_by_type": {t: round(sum(v) / len(v), 4) for t, v in by_type.items()},
                "n": len(rows),
            }

        payload = {
            "doc_id": doc_id,
            "domain": domain,
            "title": title,
            "source_url": "",
            "provenance": "FIXTURE DATA — not a real document",
            "license": "fixture",
            "tokens": doc_tokens,
            "chars": doc_tokens * 4,
            "model": ARM_MODEL,
            "pricing_snapshot": snapshot_date(),
            "computed_at": now,
        "fixture": True,
            "chunking": {"chunk_tokens": 500, "overlap_tokens": 50},
            "fixed_costs": {
                arm: {
                    "usage": fixed[arm].to_dict(),
                    "cost": price(fixed[arm], ARM_MODEL).to_dict(),
                }
                for arm in arms_pkg.ARM_ORDER
            },
            "questions": questions,
            "economics": economics,
            "cells": cells,
        }
        (RESULTS / f"{doc_id}.json").write_text(json.dumps(payload, indent=2) + "\n")
        print(f"wrote fixture {doc_id}: {len(cells)} cells")

    manifest = {
        "docs": [
            {
                "doc_id": d,
                "domain": dom,
                "title": t,
                "tokens": tok,
                "source_url": "",
                "license": "fixture",
                "provenance": "FIXTURE DATA — not a real document",
            }
            for d, dom, t, tok in sorted(DOCS, key=lambda x: x[3])
        ],
        "arms": [
            {
                "id": a,
                **arms_pkg.ARM_META[a],
                "variant_of": arms_pkg.ARM_VARIANT_GROUP.get(a),
            }
            for a in arms_pkg.ARM_ORDER
        ],
        "question_types": [{"id": t, **TYPE_META[t]} for t in TYPE_META],
        "grades": [{"id": g, **GRADE_META[g]} for g in GRADE_META],
        "credit": CREDIT,
        "model": ARM_MODEL,
        "pricing_snapshot": snapshot_date(),
        "computed_at": now,
        "fixture": True,
    }
    (RESULTS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote fixture manifest")


if __name__ == "__main__":
    main()
