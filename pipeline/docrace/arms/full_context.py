"""Arm 1 — full context.

The whole document in the prompt on every query. This is the accuracy ceiling
and the reference the other arms are read against: nothing was thrown away, so
whatever it gets wrong is a model limit rather than a retrieval limit. It pays
for the entire document on every single question.
"""

from __future__ import annotations

from .base import (
    ANSWER_SYSTEM,
    ArmResult,
    context_block,
    refusal_guard,
    result_from,
    stream_answer,
    truncation_note,
)

ARM = "full_context"


def run(*, doc_id: str, document: str, question_id: str, question: str) -> ArmResult:
    capture = stream_answer(
        system=[{"type": "text", "text": ANSWER_SYSTEM}] + context_block(document),
        messages=[{"role": "user", "content": question}],
    )
    refusal_guard(capture)
    return result_from(
        arm=ARM,
        doc_id=doc_id,
        question_id=question_id,
        capture=capture,
        notes={"context": "entire document, uncached", **truncation_note(capture)},
    )
