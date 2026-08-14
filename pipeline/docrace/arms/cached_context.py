"""Arm 2 — full context, cached, at both cache lifetimes.

The same tokens as arm 1 at a different price. Caching is not a retrieval
strategy and presenting it as a peer of the RAG arms would be wrong: accuracy is
arm 1's accuracy, because the prompt is the same document, whole, under the same
instructions — one line of cache metadata apart (see `_lifetime_marker`). What
changes is that after the first query the document bills at the cache-read rate,
roughly a tenth of fresh input.

This arm runs twice, once at each cache lifetime, because the cache TTL is the
thing that actually breaks it and a footnote is a weak way to say so. The two
variants differ only in the `ttl` — on the breakpoint, and in the marker line
that keeps their cache entries apart:

- **5 minutes** writes at 1.25x input, the cheaper write. It holds only if
  queries keep arriving inside a five-minute window. Let the window lapse and the
  next query pays the write again — and a strategy that re-writes the whole
  document every few queries is barely a cached strategy at all.
- **1 hour** writes at 2x input, so its intercept sits higher on the cost chart,
  but it survives a working session's worth of gaps.

The per-query cache-read rate is identical under both, so the difference is
entirely in how often you pay to warm the cache. Running both makes that
visible: if the 5-minute variant re-writes partway through a fifteen-question
run, the results record it, and the "Cache TTL" column in the arm table stops
being an assertion.

**Not every provider lets you choose.** A provider that caches automatically has
one undisclosed lifetime, no way to opt out, and no write premium — so there is
no TTL to vary and no warm to price separately. Those models run a third variant,
`cached_context_auto`, and its cost curve is a genuinely different shape rather
than a relabelled one: with no write premium the intercept sits at zero, so
cached full context is cheaper than uncached from the very first query instead of
after enough queries to amortise a warm. Which variants a model can run is
decided in `arms.arms_for`, off the rate card's `cache` field.
"""

from __future__ import annotations

from typing import Any

from .base import (
    ANSWER_SYSTEM,
    ArmResult,
    refusal_guard,
    result_from,
    stream_answer,
    truncation_note,
)

# One arm id per lifetime, so each gets its own measured cells, its own line on
# the cost chart, and its own row in the accuracy heatmap — where the two should
# agree, since the prompts are identical. `auto` is the provider-chosen lifetime,
# and is never measured alongside the other two: a model has either the choice or
# it doesn't.
TTLS: tuple[str, ...] = ("5m", "1h", "auto")
EXPLICIT_TTLS: tuple[str, ...] = ("5m", "1h")
ARMS: dict[str, str] = {ttl: f"cached_context_{ttl}" for ttl in TTLS}

# Kept for anything that refers to the arm generically.
ARM = ARMS["1h"]


def arm_id(ttl: str) -> str:
    if ttl not in ARMS:
        raise ValueError(f"Unsupported cache TTL {ttl!r}; expected one of {TTLS}")
    return ARMS[ttl]


def ttl_for(arm: str) -> str:
    for ttl, name in ARMS.items():
        if name == arm:
            return ttl
    raise ValueError(f"{arm!r} is not a cached-context arm")


def _lifetime_marker(ttl: str) -> dict[str, Any]:
    """One inert line naming the lifetime, so each variant caches separately.

    Cache entries are keyed by the bytes of the prefix, not by the TTL asked for.
    Without this line the two variants send the same prefix, so whichever runs
    second finds the first one's entry still live, reads it, and is never billed
    a write — and an arm that never warmed its own cache reports a $0 intercept,
    which is the one number it exists to measure. Naming the lifetime inside the
    prefix gives each variant its own entry and makes each pay its own warm.

    Two constraints on what can go here. It has to be identical across the
    questions of a run, or every question would miss and the arm would measure
    fifteen writes instead of the read rate. And it has to sit before the
    breakpoint: bytes after it are not part of the key.

    A comment rather than a tag or a sentence, because everything in this prompt
    that looks like content or instruction is one — `ANSWER_SYSTEM` tells the
    model to answer from the material it is given, and a cache lifetime is not
    part of the material.
    """
    return {"type": "text", "text": f"<!-- cache lifetime: {ttl} -->"}


def _system(document: str, ttl: str) -> list[dict[str, Any]]:
    # The breakpoint sits on the last stable block. The question lives in
    # `messages`, after the breakpoint, so it never disturbs the cached prefix.
    # There is no maximum size behind a single breakpoint, so even the largest
    # document needs exactly one — and splitting would only create extra entries
    # at prefix lengths nothing ever asks for.
    #
    # The `auto` variant carries neither: there is no breakpoint to place, and no
    # sibling variant to keep its entries apart from, so the marker line would be
    # inert text inside the prompt. Its separation happens provider-side, via the
    # isolation key `run` passes as `cache_scope`.
    if ttl == "auto":
        return [
            {"type": "text", "text": ANSWER_SYSTEM},
            {"type": "text", "text": f"<document>\n{document}\n</document>"},
        ]
    return [
        {"type": "text", "text": ANSWER_SYSTEM},
        _lifetime_marker(ttl),
        {
            "type": "text",
            "text": f"<document>\n{document}\n</document>",
            "cache_control": {"type": "ephemeral", "ttl": ttl},
        },
    ]


def run(
    *,
    doc_id: str,
    document: str,
    question_id: str,
    question: str,
    ttl: str = "1h",
) -> ArmResult:
    capture = stream_answer(
        system=_system(document, ttl),
        messages=[{"role": "user", "content": question}],
        cache_ttl=ttl,
        # Stable across the questions of one document so the second question reads
        # what the first one warmed — the whole point of the arm. Inert on
        # Anthropic, where the `cache_control` breakpoint above does this job.
        cache_scope=f"{arm_id(ttl)}:{doc_id}" if ttl == "auto" else None,
    )
    refusal_guard(capture)
    return result_from(
        arm=arm_id(ttl),
        doc_id=doc_id,
        question_id=question_id,
        capture=capture,
        notes={
            "context": "entire document, cached",
            "cache_ttl": ttl,
            # Recorded so a reader can tell a chosen lifetime from an imposed one
            # without knowing which provider served the run.
            "cache_lifetime_chosen": ttl != "auto",
            "cache_hit": capture.usage.cache_read_tokens > 0,
            # A write on anything but the first question of a run means the cache
            # lapsed and was warmed again. For the 5-minute variant that is the
            # finding, not a glitch. Always zero on `auto`: that provider bills the
            # uncached remainder as ordinary input and charges no write premium, so
            # there is no write to count.
            "cache_written": capture.usage.cache_write_tokens > 0,
            **truncation_note(capture),
        },
    )
