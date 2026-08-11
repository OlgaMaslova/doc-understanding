"""Arm 2 — full context, cached, at both cache lifetimes.

The same tokens as arm 1 at a different price. Caching is not a retrieval
strategy and presenting it as a peer of the RAG arms would be wrong: accuracy is
arm 1's accuracy, because the prompt is byte-identical. What changes is that
after the first query the document bills at the cache-read rate, roughly a tenth
of fresh input.

This arm runs twice, once at each cache lifetime, because the cache TTL is the
thing that actually breaks it and a footnote is a weak way to say so. The two
variants send identical prompts and differ only in the `ttl` on the breakpoint:

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
# agree, since the prompts are identical.
TTLS: tuple[str, ...] = ("5m", "1h")
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


def _system(document: str, ttl: str) -> list[dict[str, Any]]:
    # The breakpoint sits on the last stable block. The question lives in
    # `messages`, after the breakpoint, so it never disturbs the cached prefix.
    # There is no maximum size behind a single breakpoint, so even the largest
    # document needs exactly one — and splitting would only create extra entries
    # at prefix lengths nothing ever asks for.
    return [
        {"type": "text", "text": ANSWER_SYSTEM},
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
            "cache_hit": capture.usage.cache_read_tokens > 0,
            # A write on anything but the first question of a run means the cache
            # lapsed and was warmed again. For the 5-minute variant that is the
            # finding, not a glitch.
            "cache_written": capture.usage.cache_write_tokens > 0,
            **truncation_note(capture),
        },
    )
