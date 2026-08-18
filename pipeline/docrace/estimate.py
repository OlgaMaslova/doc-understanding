"""Project what a precompute run will cost, before running it.

Two reasons this exists. The immediate one is that nobody should authorize a paid
run without a number in front of them. The second is that the estimator is the
part of this project with standalone utility — the v2 feature is "upload your own
document and see what each strategy would cost before you spend anything", and
this is its first version.

Estimates are deliberately conservative on the arms whose cost varies (agentic
search especially), and the assumptions are printed alongside the numbers so a
figure that looks wrong can be traced to the assumption that made it wrong.

Usage:  python -m docrace.estimate [--doc ID]
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any

from . import arms as arms_pkg
from .arms import cached_context
from .chunking import CHUNK_TOKENS, chunk_document
from .contextual import BATCH as CONTEXT_BATCH
from .documents import BY_ID, load_text
from .paths import DOCS
from .grading import JUDGE_MODEL
from .pricing import ARM_MODEL, INDEX_MODEL, Usage, cache_style_of, price

# Output tokens per query. This has to include thinking, not just the visible
# answer: thinking is on by default on this model and is billed at the output
# rate. On these questions the visible answer runs a few hundred tokens and
# thinking runs several times that, which makes output a real line item rather
# than a rounding error.
ANSWER_TOKENS = 2_500
OVERHEAD_TOKENS = 250

# Assumptions for the arms whose cost is not a direct function of document size.
AGENTIC_ITERATIONS = 8
# Blocks a turn adds to the conversation: the assistant's thinking and tool_use,
# plus the tool result. The loop re-sends the whole history every iteration, so
# what matters is how the history *grows*, not a flat per-call figure.
AGENTIC_TOKENS_PER_TURN = 2_000
AGENTIC_SEED_TOKENS = 600
EXTRACTION_OUTPUT_TOKENS = 6_000
EXTRACT_RECORD_TOKENS = 4_000
CHARS_PER_TOKEN = 3.7

ASSUMPTIONS = f"""assumptions
  output per query                  {ANSWER_TOKENS} tokens, thinking included
  prompt overhead                   {OVERHEAD_TOKENS} tokens per query
  agentic search                    {AGENTIC_ITERATIONS} iterations, history growing
                                    {AGENTIC_TOKENS_PER_TURN} tokens per turn, prefix cached
  extraction output                 {EXTRACTION_OUTPUT_TOKENS} tokens per window
  extracted record size             {EXTRACT_RECORD_TOKENS} tokens per query, cached
  retrieved context                 top-5 chunks at ~{CHUNK_TOKENS} tokens
  token counts                      chars/{CHARS_PER_TOKEN} unless a committed count exists
  answering model                   {ARM_MODEL}
  indexing model                    {INDEX_MODEL}, at its own rates
                                    (contextual prefixes and extraction only)
  judge                             {JUDGE_MODEL}, one call per cell, priced as a query"""


@dataclass
class Projection:
    arm: str
    fixed_usd: float
    per_query_usd: float
    queries: int

    @property
    def total_usd(self) -> float:
        return self.fixed_usd + self.per_query_usd * self.queries


def doc_tokens(doc_id: str) -> int:
    """Committed token count if the document has been fetched with a key, else an estimate."""
    meta_path = BY_ID[doc_id].meta_path
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        if meta.get("tokens"):
            return int(meta["tokens"])
    return int(len(load_text(doc_id)) / CHARS_PER_TOKEN)


def project(doc_id: str, questions: int) -> list[Projection]:
    tokens = doc_tokens(doc_id)
    chunks = len(chunk_document(load_text(doc_id)))
    retrieved = 5 * CHUNK_TOKENS

    def cost(usage: Usage) -> float:
        return price(usage, ARM_MODEL).total

    def index_cost(usage: Usage) -> float:
        # Indexing work (contextual prefixes, extraction windows) runs on
        # INDEX_MODEL, which follows DOCRACE_MODEL unless the run pinned it — see
        # pricing.py. Pricing it at ARM_MODEL would skew every fixed-cost intercept
        # in exactly the case a pinned index is interesting.
        return price(usage, INDEX_MODEL).total

    # An index model whose provider caches on its own has no write premium to pay
    # and no lifetime to choose: the first call that sends the document is billed
    # as ordinary input and the rest read it back. Projecting a 1h write against
    # such a model would invent a line item its bill will never show — and `price`
    # refuses to quote one, so this is a hard branch, not a rounding choice.
    index_warms = cache_style_of(INDEX_MODEL) == "explicit_ttl"

    def index_prefix(prefix_tokens: int, reads: int) -> dict[str, int]:
        """Token flow for a document held across several indexing calls."""
        if index_warms:
            return {
                "cache_write_1h_tokens": prefix_tokens,
                "cache_read_tokens": prefix_tokens * reads,
            }
        return {
            "input_tokens": prefix_tokens,
            "cache_read_tokens": prefix_tokens * reads,
        }

    out: list[Projection] = []

    out.append(
        Projection(
            "full_context",
            0.0,
            cost(
                Usage(
                    input_tokens=tokens + OVERHEAD_TOKENS,
                    output_tokens=ANSWER_TOKENS,
                )
            ),
            questions,
        )
    )

    # Whichever cache variants this model can actually run — both lifetimes when
    # the request gets to choose one, otherwise the single provider-default arm.
    # The per-query cost is identical across all of them (the cache-read rate does
    # not depend on the lifetime); what differs is the price of warming the cache,
    # which is where the auto variant's intercept goes to zero: that provider bills
    # the first query's uncached remainder as ordinary input and charges no write
    # premium, so there is no separate warm to project.
    per_query_cached = cost(
        Usage(
            cache_read_tokens=tokens,
            input_tokens=OVERHEAD_TOKENS,
            output_tokens=ANSWER_TOKENS,
        )
    )
    cache_writes = {
        "5m": "cache_write_5m_tokens",
        "1h": "cache_write_1h_tokens",
        "auto": None,
    }
    for ttl in cached_context.TTLS:
        arm = cached_context.arm_id(ttl)
        if arm not in arms_pkg.ARM_ORDER:
            continue
        field = cache_writes[ttl]
        warm = cost(Usage(**{field: tokens})) if field else 0.0
        out.append(Projection(arm, warm, per_query_cached, questions))

    out.append(
        Projection(
            "naive_rag",
            cost(Usage(embed_tokens=tokens)),
            cost(
                Usage(
                    input_tokens=retrieved + OVERHEAD_TOKENS,
                    output_tokens=ANSWER_TOKENS,
                    embed_tokens=30,
                )
            ),
            questions,
        )
    )

    # The contextual-prefix pass: the document cached once, then read back on each
    # batch of chunks. This is the indexing bill that scales with document size.
    batches = max(1, -(-chunks // CONTEXT_BATCH))
    out.append(
        Projection(
            "hybrid_rag",
            index_cost(
                Usage(
                    output_tokens=chunks * 70,
                    embed_tokens=int(tokens * 1.4),
                    calls=batches,
                )
                + Usage(input_tokens=chunks * (CHUNK_TOKENS + 50))
                + Usage(**index_prefix(tokens, max(0, batches - 1)))
            ),
            cost(
                Usage(
                    input_tokens=int(retrieved * 1.2) + OVERHEAD_TOKENS,
                    output_tokens=ANSWER_TOKENS,
                    embed_tokens=30,
                    rerank_tokens=20 * CHUNK_TOKENS,
                )
            ),
            questions,
        )
    )

    # The loop re-sends the whole conversation each iteration, so input billed is
    # the sum of history sizes rather than a flat per-call figure — modelling it as
    # a flat figure understates this arm by roughly threefold. With the prefix
    # cached, each turn reads everything before it and pays fresh only for the new
    # turn.
    # A provider that caches automatically charges no write premium, so the same
    # token flow carries no write line — matching what the arm actually records.
    warms = cache_style_of(ARM_MODEL) == "explicit_ttl"

    def write(tokens: int) -> dict[str, int]:
        return {"cache_write_5m_tokens": tokens} if warms else {}

    history = AGENTIC_SEED_TOKENS
    agentic = Usage()
    for turn in range(AGENTIC_ITERATIONS):
        if turn == 0:
            agentic = agentic + Usage(
                input_tokens=history, calls=1, **write(history)
            )
        else:
            agentic = agentic + Usage(
                cache_read_tokens=history - AGENTIC_TOKENS_PER_TURN,
                input_tokens=AGENTIC_TOKENS_PER_TURN,
                calls=1,
                **write(AGENTIC_TOKENS_PER_TURN),
            )
        history += AGENTIC_TOKENS_PER_TURN
    agentic = agentic + Usage(output_tokens=ANSWER_TOKENS + AGENTIC_ITERATIONS * 200)
    out.append(Projection("agentic", 0.0, cost(agentic), questions))

    windows = max(1, -(-tokens // 30_000))
    out.append(
        Projection(
            "extract",
            # The extraction pass, plus warming the cache over the record once.
            index_cost(
                Usage(
                    input_tokens=tokens + 400 * windows,
                    output_tokens=EXTRACTION_OUTPUT_TOKENS * windows,
                    calls=windows,
                )
                # Warming the cache over the record, once — and only where warming
                # is a billable event. The arm's own cache is the answering model's,
                # so this one line is priced at the index model but sized by the arm.
                + Usage(
                    **(
                        {"cache_write_1h_tokens": EXTRACT_RECORD_TOKENS}
                        if index_warms
                        else {}
                    )
                )
            ),
            # The record is identical for every question, so it reads from cache.
            cost(
                Usage(
                    cache_read_tokens=EXTRACT_RECORD_TOKENS,
                    input_tokens=OVERHEAD_TOKENS,
                    output_tokens=ANSWER_TOKENS,
                )
            ),
            questions,
        )
    )

    return out


def judge_cost(questions: int, *, arms: int | None = None) -> float:
    """One judge call per cell — every selected arm, every selected question.

    Priced at the judge's own model: the judge stays on JUDGE_MODEL whatever the
    arms run on, so an estimate for a cheap arm model must not discount grading.
    """
    per_call = price(
        Usage(input_tokens=1_500, output_tokens=150), JUDGE_MODEL
    ).total
    return per_call * questions * (arms if arms is not None else len(arms_pkg.ARM_ORDER))


def main() -> None:
    ap = argparse.ArgumentParser(description="Project the cost of a precompute run.")
    ap.add_argument("--doc", action="append", help="Doc id; repeatable. Default: all.")
    ap.add_argument(
        "--questions",
        type=int,
        default=15,
        help="Questions per document (default 15: 5 types x 3).",
    )
    # Mirrors precompute's --arm so any scope can be priced with the same flags
    # that will run it. Indexing is skipped for unselected arms, exactly as the
    # real run skips it.
    ap.add_argument("--arm", action="append", help="Arm id; repeatable. Default: all.")
    ap.add_argument(
        "--json",
        action="store_true",
        help=(
            "Emit the projection as JSON instead of a table. The web app's run "
            "panel prices a scope through this, so the cost model lives here only."
        ),
    )
    args = ap.parse_args()

    for arm in args.arm or []:
        if arm not in arms_pkg.ARM_ORDER:
            raise SystemExit(
                f"Unknown arm {arm!r}. Known: {', '.join(arms_pkg.ARM_ORDER)}"
            )

    doc_ids = args.doc or [
        s.doc_id for s in BY_ID.values() if (DOCS / f"{s.doc_id}.txt").exists()
    ]
    if not doc_ids:
        raise SystemExit(
            "No documents fetched yet — run `python -m docrace.documents` first."
        )

    if args.json:
        payload: dict[str, Any] = {"documents": [], "total_usd": 0.0}
        for doc_id in doc_ids:
            projections = project(doc_id, args.questions)
            if args.arm:
                projections = [p for p in projections if p.arm in set(args.arm)]
            judge = judge_cost(args.questions, arms=len(projections))
            subtotal = sum(p.total_usd for p in projections)
            payload["documents"].append(
                {
                    "doc_id": doc_id,
                    "tokens": doc_tokens(doc_id),
                    "questions": args.questions,
                    "arms": [
                        {
                            "arm": p.arm,
                            "indexing_usd": round(p.fixed_usd, 6),
                            "per_query_usd": round(p.per_query_usd, 6),
                            "total_usd": round(p.total_usd, 6),
                        }
                        for p in projections
                    ],
                    "grading_usd": round(judge, 6),
                    "total_usd": round(subtotal + judge, 6),
                }
            )
            payload["total_usd"] += subtotal + judge
        payload["total_usd"] = round(payload["total_usd"], 6)
        # Named rather than left implicit: the run panel prices a scope through
        # this, and the indexing model is the one input to the number that the
        # panel's model picker does not obviously determine.
        payload["arm_model"] = ARM_MODEL
        payload["index_model"] = INDEX_MODEL
        payload["judge_model"] = JUDGE_MODEL
        payload["assumptions"] = ASSUMPTIONS
        print(json.dumps(payload, indent=2))
        return

    grand = 0.0
    note = "" if INDEX_MODEL == ARM_MODEL else "  (pinned)"
    print(
        f"\nanswering with {ARM_MODEL}; indexing with {INDEX_MODEL}{note}; "
        f"grading with {JUDGE_MODEL}"
    )
    for doc_id in doc_ids:
        projections = project(doc_id, args.questions)
        if args.arm:
            projections = [p for p in projections if p.arm in set(args.arm)]
        tokens = doc_tokens(doc_id)
        print(f"\n{doc_id}  ~{tokens:,} tokens  x {args.questions} questions")
        print(f"  {'arm':20} {'indexing':>10} {'per query':>11} {'run total':>11}")
        for p in projections:
            print(
                f"  {p.arm:20} {p.fixed_usd:>10.4f} {p.per_query_usd:>11.5f} "
                f"{p.total_usd:>11.4f}"
            )
        subtotal = sum(p.total_usd for p in projections)
        judge = judge_cost(args.questions, arms=len(projections))
        print(f"  {'arms subtotal':20} {'':>10} {'':>11} {subtotal:>11.4f}")
        print(f"  {'grading':20} {'':>10} {'':>11} {judge:>11.4f}")
        print(f"  {'document total':20} {'':>10} {'':>11} {subtotal + judge:>11.4f}")
        grand += subtotal + judge

    print(f"\nprojected total for this run: ${grand:.2f}")
    print(f"\n{ASSUMPTIONS}")
    print(
        "\nThese are projections, not quotes. Agentic search is the least "
        "predictable arm — its real cost depends on how many searches each "
        "question provokes."
    )


if __name__ == "__main__":
    main()
