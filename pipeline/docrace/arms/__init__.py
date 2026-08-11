"""The arms: six strategies, seven measured arms.

Order matters for presentation and for the precompute run: full context comes
first so its uncached numbers are recorded before the cached arm writes a cache
entry over the same tokens.
"""

from . import agentic, cached_context, extract, full_context, hybrid_rag, naive_rag
from .base import ArmResult

ARM_ORDER: tuple[str, ...] = (
    full_context.ARM,
    cached_context.ARMS["5m"],
    cached_context.ARMS["1h"],
    naive_rag.ARM,
    hybrid_rag.ARM,
    agentic.ARM,
    extract.ARM,
)

# Six strategies, seven measured arms: caching is one strategy run at both cache
# lifetimes, because the TTL is what breaks it and measuring both says so more
# convincingly than a caveat. Variants share a group so the UI can present them
# as one strategy without pretending they are one measurement.
ARM_VARIANT_GROUP: dict[str, str] = {
    cached_context.ARMS["5m"]: "cached_context",
    cached_context.ARMS["1h"]: "cached_context",
}

# Arms whose cached prefix is shared across every question about a document: the
# document itself for the full-context arms, the extracted record for arm 6. For
# these, warming the cache is a one-time cost and belongs in the chart's
# intercept.
#
# Arm 5 is deliberately not in this set. It caches too, but each question starts a
# fresh conversation, so its warm is paid per query and belongs in the slope. Fold
# it into the intercept instead and the arm looks far cheaper per query than it is.
ARM_CACHE_SHARED_ACROSS_QUERIES: frozenset[str] = frozenset(
    {
        cached_context.ARMS["5m"],
        cached_context.ARMS["1h"],
        extract.ARM,
    }
)

# Display metadata, kept next to the implementations so the UI and the README
# cannot drift from what the code actually does.
ARM_META: dict[str, dict[str, str]] = {
    full_context.ARM: {
        "label": "Full context",
        "short": "Whole document in the prompt, every query",
        "wins": "Accuracy ceiling — the reference the others are read against",
        "breaks": "Cost scales linearly with queries x document size",
    },
    cached_context.ARMS["5m"]: {
        "label": "Full context + cache (5 min)",
        "short": "Same tokens, cached for five minutes",
        "wins": "The cheapest write, if queries keep arriving inside the window",
        "breaks": "Let the window lapse and the next query pays the write again",
    },
    cached_context.ARMS["1h"]: {
        "label": "Full context + cache (1 hour)",
        "short": "Same tokens, cached for an hour",
        "wins": "Arm 1's accuracy at roughly a tenth of the marginal cost",
        "breaks": "Write costs 2x input, not 1.25x; still scales with document size",
    },
    naive_rag.ARM: {
        "label": "Naive chunk RAG",
        "short": "Fixed-size chunks, embedding search, top-5",
        "wins": "Cheap, and flat in document size",
        "breaks": "Aggregation, multi-hop, absence",
    },
    hybrid_rag.ARM: {
        "label": "Hybrid + contextual",
        "short": "BM25 + embeddings, LLM chunk prefixes, reranked",
        "wins": "The honest RAG baseline; recovers most of naive RAG's losses",
        "breaks": "A real indexing bill that scales with document size",
    },
    agentic.ARM: {
        "label": "Agentic search",
        "short": "Model gets grep and read over the document, iterates",
        "wins": "Multi-hop, without the whole document in context",
        "breaks": "Slowest by far, and cost varies per query",
    },
    extract.ARM: {
        "label": "Extract then query",
        "short": "One map-reduce pass into a schema; queries hit the output",
        "wins": "Near-zero marginal cost; unbeatable on aggregation",
        "breaks": "Answers only what the schema anticipated",
    },
}

__all__ = [
    "ARM_ORDER",
    "ARM_META",
    "ARM_VARIANT_GROUP",
    "ArmResult",
    "full_context",
    "cached_context",
    "naive_rag",
    "hybrid_rag",
    "agentic",
    "extract",
]
