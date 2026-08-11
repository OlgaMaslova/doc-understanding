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

from . import arms as arms_pkg
from .chunking import CHUNK_TOKENS, chunk_document
from .contextual import BATCH as CONTEXT_BATCH
from .documents import BY_ID, load_text
from .paths import DOCS
from .pricing import ARM_MODEL, Usage, price

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
  judge                             one call per cell, priced as a query"""


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

    # Both cache lifetimes are measured, so both are projected. The per-query cost
    # is identical — the cache-read rate does not depend on the TTL — and the only
    # difference is the price of warming the cache.
    for ttl, field in (("5m", "cache_write_5m_tokens"), ("1h", "cache_write_1h_tokens")):
        out.append(
            Projection(
                f"cached_context_{ttl}",
                cost(Usage(**{field: tokens})),
                cost(
                    Usage(
                        cache_read_tokens=tokens,
                        input_tokens=OVERHEAD_TOKENS,
                        output_tokens=ANSWER_TOKENS,
                    )
                ),
                questions,
            )
        )

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
            cost(
                Usage(
                    cache_write_1h_tokens=tokens,
                    cache_read_tokens=tokens * max(0, batches - 1),
                    input_tokens=chunks * (CHUNK_TOKENS + 50),
                    output_tokens=chunks * 70,
                    embed_tokens=int(tokens * 1.4),
                    calls=batches,
                )
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
    history = AGENTIC_SEED_TOKENS
    agentic = Usage()
    for turn in range(AGENTIC_ITERATIONS):
        if turn == 0:
            agentic = agentic + Usage(
                input_tokens=history, cache_write_5m_tokens=history, calls=1
            )
        else:
            agentic = agentic + Usage(
                cache_read_tokens=history - AGENTIC_TOKENS_PER_TURN,
                input_tokens=AGENTIC_TOKENS_PER_TURN,
                cache_write_5m_tokens=AGENTIC_TOKENS_PER_TURN,
                calls=1,
            )
        history += AGENTIC_TOKENS_PER_TURN
    agentic = agentic + Usage(output_tokens=ANSWER_TOKENS + AGENTIC_ITERATIONS * 200)
    out.append(Projection("agentic", 0.0, cost(agentic), questions))

    windows = max(1, -(-tokens // 30_000))
    out.append(
        Projection(
            "extract",
            # The extraction pass, plus warming the cache over the record once.
            cost(
                Usage(
                    input_tokens=tokens + 400 * windows,
                    output_tokens=EXTRACTION_OUTPUT_TOKENS * windows,
                    cache_write_1h_tokens=EXTRACT_RECORD_TOKENS,
                    calls=windows,
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
    """One judge call per cell — every selected arm, every selected question."""
    per_call = price(
        Usage(input_tokens=1_500, output_tokens=150), ARM_MODEL
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

    grand = 0.0
    for doc_id in doc_ids:
        projections = project(doc_id, args.questions)
        if args.arm:
            projections = [p for p in projections if p.arm in set(args.arm)]
        tokens = doc_tokens(doc_id)
        print(f"\n{doc_id}  ~{tokens:,} tokens  x {args.questions} questions")
        print(f"  {'arm':16} {'indexing':>10} {'per query':>11} {'run total':>11}")
        for p in projections:
            print(
                f"  {p.arm:16} {p.fixed_usd:>10.4f} {p.per_query_usd:>11.5f} "
                f"{p.total_usd:>11.4f}"
            )
        subtotal = sum(p.total_usd for p in projections)
        judge = judge_cost(args.questions, arms=len(projections))
        print(f"  {'arms subtotal':16} {'':>10} {'':>11} {subtotal:>11.4f}")
        print(f"  {'grading':16} {'':>10} {'':>11} {judge:>11.4f}")
        print(f"  {'document total':16} {'':>10} {'':>11} {subtotal + judge:>11.4f}")
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
