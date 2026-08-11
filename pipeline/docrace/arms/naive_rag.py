"""Arm 3 — naive chunk RAG.

Fixed-size chunks, embedding search, top-k. This is the strategy most people
picture when they say "RAG", and its cost is flat in document size, which is the
whole reason it survives on the 10-K. Watch it on aggregation and absence: it
always returns five chunks, and five chunks is what a wrong answer gets built
from.
"""

from __future__ import annotations

from ..pricing import Usage
from ..retrieval import Index
from .base import (
    ANSWER_SYSTEM,
    ArmResult,
    refusal_guard,
    result_from,
    stream_answer,
    truncation_note,
)

ARM = "naive_rag"
TOP_K = 5

RETRIEVAL_SYSTEM = ANSWER_SYSTEM + (
    "\n\nYou are given excerpts retrieved from the document, not the whole "
    "document. If answering would require material outside these excerpts — a "
    "count across the entire document, or confirmation that something is absent "
    "— say that the excerpts are insufficient rather than answering from them."
)


def _prompt(chunks: list[tuple[int, str]], question: str) -> str:
    joined = "\n\n".join(
        f"<excerpt index=\"{idx}\">\n{text}\n</excerpt>" for idx, text in chunks
    )
    return f"{joined}\n\nQuestion: {question}"


def run(
    *,
    doc_id: str,
    index: Index,
    question_id: str,
    question: str,
) -> ArmResult:
    ids, retrieval_usage = index.dense(question, TOP_K)
    chunks = [(i, index.texts[i]) for i in ids]

    capture = stream_answer(
        system=RETRIEVAL_SYSTEM,
        messages=[{"role": "user", "content": _prompt(chunks, question)}],
    )
    refusal_guard(capture)

    total: Usage = capture.usage + retrieval_usage
    return result_from(
        arm=ARM,
        doc_id=doc_id,
        question_id=question_id,
        capture=capture,
        usage=total,
        notes={
            "retrieved_chunks": ids,
            "top_k": TOP_K,
            "retrieval": "embedding cosine similarity, no reranking",
            **truncation_note(capture),
        },
    )
