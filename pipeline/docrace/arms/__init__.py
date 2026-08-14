"""The arms: six strategies, seven measured arms on a model with cache TTLs.

Order matters for presentation and for the precompute run: full context comes
first so its uncached numbers are recorded before the cached arm writes a cache
entry over the same tokens.

**The arm set depends on the answering model**, because one arm measures a
provider capability rather than a retrieval strategy. A model whose provider lets
the request choose a cache lifetime runs both TTL variants; a model whose
provider caches automatically runs the single `auto` variant instead. Everything
else is identical across models. `ALL_ARMS` is the union in canonical order — use
it for metadata lookups and for describing result sets other than this run's;
`ARM_ORDER` is this run's set, resolved from `DOCRACE_MODEL` at import, the same
way `ARM_MODEL` is.
"""

from . import agentic, cached_context, extract, full_context, hybrid_rag, naive_rag
from .base import ArmResult
from ..pricing import ARM_MODEL, cache_style_of

# Every arm any model can run, in presentation order. Nothing runs this whole
# set: the three cached variants are mutually exclusive per model.
ALL_ARMS: tuple[str, ...] = (
    full_context.ARM,
    cached_context.ARMS["5m"],
    cached_context.ARMS["1h"],
    cached_context.ARMS["auto"],
    naive_rag.ARM,
    hybrid_rag.ARM,
    agentic.ARM,
    extract.ARM,
)

# Which cached-context variants each cache style supports. 'none' would run the
# comparison without a cached arm at all; no model in the rate card declares it
# today, but the mapping is here so adding one is a rate-card edit.
_CACHE_VARIANTS: dict[str, tuple[str, ...]] = {
    "explicit_ttl": (cached_context.ARMS["5m"], cached_context.ARMS["1h"]),
    "auto": (cached_context.ARMS["auto"],),
    "none": (),
}


def arms_for(model: str) -> tuple[str, ...]:
    """The arms `model` can actually run, in presentation order."""
    keep = set(_CACHE_VARIANTS[cache_style_of(model)])
    dropped = set(_CACHE_VARIANTS["explicit_ttl"] + _CACHE_VARIANTS["auto"]) - keep
    return tuple(arm for arm in ALL_ARMS if arm not in dropped)


ARM_ORDER: tuple[str, ...] = arms_for(ARM_MODEL)

# Six strategies, seven measured arms: caching is one strategy run at both cache
# lifetimes, because the TTL is what breaks it and measuring both says so more
# convincingly than a caveat. Variants share a group so the UI can present them
# as one strategy without pretending they are one measurement.
#
# The `auto` variant is grouped too, though it was once left out on the grounds
# that it is the only cached arm its model runs and a group of one says nothing.
# That held while a manifest described a single model. It does not now: a manifest
# is the union over every result set on disk, so a run of the same document on two
# providers puts all three variants in front of the reader at once. Left ungrouped,
# the provider-default lifetime reads as a seventh strategy sitting beside caching
# rather than as the way the same strategy is measured where the request cannot
# choose a lifetime — and nothing could line the two models up on one row.
ARM_VARIANT_GROUP: dict[str, str] = {
    cached_context.ARMS["5m"]: "cached_context",
    cached_context.ARMS["1h"]: "cached_context",
    cached_context.ARMS["auto"]: "cached_context",
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
        cached_context.ARMS["auto"],
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
        # No "arm 1" — this string is rendered in the UI, which calls these
        # approaches and numbers them differently, so it has to name the thing.
        "wins": "Full context's accuracy at roughly a tenth of the marginal cost",
        "breaks": "Write costs 2x input, not 1.25x; still scales with document size",
    },
    cached_context.ARMS["auto"]: {
        "label": "Full context + cache (provider default)",
        "short": "Same tokens, cached at a lifetime the provider chooses",
        "wins": "No write premium, so it beats uncached from the first query",
        "breaks": "No control over the lifetime, and no way to measure a lapse",
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
    "ALL_ARMS",
    "ARM_ORDER",
    "ARM_META",
    "ARM_VARIANT_GROUP",
    "ArmResult",
    "arms_for",
    "full_context",
    "cached_context",
    "naive_rag",
    "hybrid_rag",
    "agentic",
    "extract",
]
