"""Arm 4 — hybrid retrieval with contextual chunk prefixes and reranking.

This is the honest RAG baseline, and it is not optional. A strawman retrieval arm
would make the whole comparison suspect: of course full context wins if the
alternative is undertuned. Every parameter here is documented in the README so
the tuning is auditable.

The pipeline: contextual prefixes at index time (see contextual.py), then per
query, BM25 and embedding search fused by reciprocal rank, then a cross-encoder
reranker over the fused candidates, then the top 5 into the prompt.
"""

from __future__ import annotations

from ..pricing import Usage
from ..retrieval import Index, rerank
from .base import (
    ANSWER_SYSTEM,
    ArmResult,
    refusal_guard,
    result_from,
    stream_answer,
    truncation_note,
)

ARM = "hybrid_rag"
FUSE_K = 20
TOP_K = 5

RETRIEVAL_SYSTEM = ANSWER_SYSTEM + (
    "\n\nYou are given excerpts retrieved from the document, not the whole "
    "document. Each excerpt begins with a line situating it within the "
    "document. If answering would require material outside these excerpts — a "
    "count across the entire document, or confirmation that something is absent "
    "— say that the excerpts are insufficient rather than answering from them."
)


def _prompt(chunks: list[tuple[int, str]], question: str) -> str:
    joined = "\n\n".join(
        f'<excerpt index="{idx}">\n{text}\n</excerpt>' for idx, text in chunks
    )
    return f"{joined}\n\nQuestion: {question}"


def run(
    *,
    doc_id: str,
    index: Index,
    question_id: str,
    question: str,
) -> ArmResult:
    candidate_ids, retrieval_usage = index.hybrid(question, fuse_k=FUSE_K)
    candidates = [index.texts[i] for i in candidate_ids]

    ranked, rerank_usage = rerank(question, candidates, TOP_K)
    retrieval_usage = retrieval_usage + rerank_usage
    chunks = [(candidate_ids[local], candidates[local]) for local, _ in ranked]

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
            "retrieved_chunks": [idx for idx, _ in chunks],
            "fused_candidates": candidate_ids,
            "fuse_k": FUSE_K,
            "top_k": TOP_K,
            "retrieval": (
                "contextual prefixes, BM25 + embeddings fused by reciprocal rank, "
                "cross-encoder reranked"
            ),
            **truncation_note(capture),
        },
    )
