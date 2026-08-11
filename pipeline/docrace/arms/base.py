"""Common shape for every arm.

An arm answers one question about one document and reports what it cost. Deltas
are recorded with their arrival times so replay mode can reproduce the race at
original pacing without spending anything at request time.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from ..client import anthropic_client
from ..pricing import ARM_MODEL, Cost, Usage, price

# Thinking is on by default on this model and counts against max_tokens along
# with the response text. A budget sized for the answer alone would truncate
# mid-sentence on the hard questions — and a truncated answer grades as wrong,
# which would look like an arm failing when it was the harness that failed.
MAX_TOKENS = 16_000

ANSWER_SYSTEM = (
    "You answer questions about a single document.\n\n"
    "Answer only from the material you are given. Quote or cite the specific "
    "provision, figure, or passage the answer rests on. If the material does "
    "not contain the answer, say so plainly and say what you would need — do "
    "not infer a plausible-sounding answer from adjacent text. If the question "
    "asks for a count or a total, state the number and enumerate what you "
    "counted.\n\n"
    "Be direct. Lead with the answer, then the support."
)


@dataclass
class ArmResult:
    arm: str
    doc_id: str
    question_id: str
    answer: str
    deltas: list[tuple[int, str]]
    usage: Usage
    cost: Cost
    latency_ms: int
    ttft_ms: int
    notes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "arm": self.arm,
            "doc_id": self.doc_id,
            "question_id": self.question_id,
            "answer": self.answer,
            "deltas": [[t, s] for t, s in self.deltas],
            "usage": self.usage.to_dict(),
            "cost": self.cost.to_dict(),
            "latency_ms": self.latency_ms,
            "ttft_ms": self.ttft_ms,
            "notes": self.notes,
        }


@dataclass
class StreamCapture:
    """One streamed Claude call: the text, its timing, and its usage."""

    text: str
    deltas: list[tuple[int, str]]
    usage: Usage
    latency_ms: int
    ttft_ms: int
    stop_reason: str | None
    raw: Any


def stream_answer(
    *,
    system: Any,
    messages: list[dict],
    tools: list[dict] | None = None,
    model: str = ARM_MODEL,
    max_tokens: int = MAX_TOKENS,
    started_at: float | None = None,
    extra: dict | None = None,
    cache_ttl: str = "5m",
) -> StreamCapture:
    """Stream one message, capturing text deltas with millisecond arrival times.

    Streaming is not optional here: at these `max_tokens` a non-streaming
    request risks an HTTP timeout, and the delta timings are the raw material
    replay mode runs on.
    """
    client = anthropic_client()
    t0 = started_at if started_at is not None else time.perf_counter()
    deltas: list[tuple[int, str]] = []
    ttft_ms = 0

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }
    if tools:
        kwargs["tools"] = tools
    if extra:
        kwargs.update(extra)

    with client.messages.stream(**kwargs) as stream:
        for event in stream:
            if (
                event.type == "content_block_delta"
                and getattr(event.delta, "type", None) == "text_delta"
            ):
                elapsed = int((time.perf_counter() - t0) * 1000)
                if not deltas:
                    ttft_ms = elapsed
                deltas.append((elapsed, event.delta.text))
        message = stream.get_final_message()

    latency_ms = int((time.perf_counter() - t0) * 1000)
    text = "".join(
        block.text for block in message.content if getattr(block, "type", "") == "text"
    )
    return StreamCapture(
        text=text,
        deltas=deltas,
        usage=Usage.from_message_usage(message.usage, ttl=cache_ttl),
        latency_ms=latency_ms,
        ttft_ms=ttft_ms,
        stop_reason=message.stop_reason,
        raw=message,
    )


def result_from(
    *,
    arm: str,
    doc_id: str,
    question_id: str,
    capture: StreamCapture,
    usage: Usage | None = None,
    latency_ms: int | None = None,
    notes: dict | None = None,
    model: str = ARM_MODEL,
) -> ArmResult:
    total = usage if usage is not None else capture.usage
    return ArmResult(
        arm=arm,
        doc_id=doc_id,
        question_id=question_id,
        answer=capture.text,
        deltas=capture.deltas,
        usage=total,
        cost=price(total, model),
        latency_ms=latency_ms if latency_ms is not None else capture.latency_ms,
        ttft_ms=capture.ttft_ms,
        notes=notes or {},
    )


def refusal_guard(capture: StreamCapture) -> None:
    """Fail loudly on a safety refusal rather than grading an empty answer.

    `stop_reason == "refusal"` arrives as a normal 200 with empty or partial
    content, so code that reads the text unconditionally would silently record
    a blank answer as an arm failure.
    """
    if capture.stop_reason == "refusal":
        details = getattr(capture.raw, "stop_details", None)
        category = getattr(details, "category", None)
        raise RuntimeError(
            f"Model declined the request (category={category}). "
            "This is a classifier refusal, not an arm failure — reword the question "
            "or exclude it from the preset set."
        )


def truncation_note(capture: StreamCapture) -> dict[str, Any]:
    """Flag an answer that ran out of output budget.

    A truncated answer grades as wrong, so it has to be distinguishable from an
    arm that genuinely got the question wrong. If this shows up, raise MAX_TOKENS
    rather than accepting the grade.
    """
    if capture.stop_reason == "max_tokens":
        return {"truncated": True}
    return {}


def context_block(document: str, *, cache: bool = False) -> list[dict]:
    """The document as a content block, optionally cached.

    Caching is a cost transform on identical tokens, not a different strategy:
    arms 1 and 2 send byte-identical prompts and differ only in whether this
    block carries a cache breakpoint.
    """
    block: dict[str, Any] = {
        "type": "text",
        "text": f"<document>\n{document}\n</document>",
    }
    if cache:
        block["cache_control"] = {"type": "ephemeral"}
    return [block]
