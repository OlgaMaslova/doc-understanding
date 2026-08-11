"""Retrieval substrate for arms 3 and 4.

Vectors live in a numpy array in memory. Three documents do not need a vector
database, and standing one up would be the cargo-culting this project is
supposed to be an argument against.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx
import numpy as np
from rank_bm25 import BM25Okapi

from .client import voyage_api_key
from .pricing import Usage, pricing

EMBED_ENDPOINT = "https://api.voyageai.com/v1/embeddings"
RERANK_ENDPOINT = "https://api.voyageai.com/v1/rerank"

# Voyage caps a single embeddings request at 1000 inputs; stay well under so a
# long 10-K's chunks batch predictably.
EMBED_BATCH = 128
RRF_K = 60

_WORD = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _post(url: str, payload: dict) -> dict:
    with httpx.Client(timeout=120.0) as c:
        r = c.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {voyage_api_key()}"},
        )
        if r.status_code >= 400:
            raise RuntimeError(f"Voyage {url} returned {r.status_code}: {r.text[:400]}")
        return r.json()


def embed(texts: list[str], *, input_type: str) -> tuple[np.ndarray, Usage]:
    """Embed `texts`. `input_type` is "document" or "query" — Voyage embeds the
    two asymmetrically, and using "document" for queries measurably hurts recall.
    """
    model = pricing()["voyage"]["embedding_model"]
    vectors: list[list[float]] = []
    tokens = 0
    for start in range(0, len(texts), EMBED_BATCH):
        batch = texts[start : start + EMBED_BATCH]
        data = _post(
            EMBED_ENDPOINT,
            {"input": batch, "model": model, "input_type": input_type},
        )
        # Voyage does not guarantee response order matches request order.
        ordered = sorted(data["data"], key=lambda d: d["index"])
        vectors.extend(d["embedding"] for d in ordered)
        tokens += data.get("usage", {}).get("total_tokens", 0)
    arr = np.asarray(vectors, dtype=np.float32)
    arr /= np.linalg.norm(arr, axis=1, keepdims=True)
    return arr, Usage(embed_tokens=tokens)


def rerank(
    query: str, documents: list[str], top_k: int
) -> tuple[list[tuple[int, float]], Usage]:
    """Return [(index_into_documents, score)] best-first."""
    model = pricing()["voyage"]["rerank_model"]
    data = _post(
        RERANK_ENDPOINT,
        {
            "query": query,
            "documents": documents,
            "model": model,
            "top_k": min(top_k, len(documents)),
        },
    )
    ranked = [(d["index"], d["relevance_score"]) for d in data["data"]]
    ranked.sort(key=lambda t: -t[1])
    return ranked, Usage(rerank_tokens=data.get("usage", {}).get("total_tokens", 0))


@dataclass
class Index:
    """An embedding + BM25 index over one set of chunk texts.

    Arms 3 and 4 build separate indexes over the same segmentation: arm 3 over
    the raw chunks, arm 4 over chunks with LLM-written contextual prefixes.
    """

    texts: list[str]
    vectors: np.ndarray
    bm25: BM25Okapi
    build_usage: Usage

    @classmethod
    def build(cls, texts: list[str]) -> "Index":
        vectors, usage = embed(texts, input_type="document")
        return cls(
            texts=texts,
            vectors=vectors,
            bm25=BM25Okapi([tokenize(t) for t in texts]),
            build_usage=usage,
        )

    def dense(self, query: str, k: int) -> tuple[list[int], Usage]:
        qv, usage = embed([query], input_type="query")
        scores = self.vectors @ qv[0]
        order = np.argsort(-scores)[:k]
        return [int(i) for i in order], usage

    def sparse(self, query: str, k: int) -> list[int]:
        scores = self.bm25.get_scores(tokenize(query))
        return [int(i) for i in np.argsort(-scores)[:k]]

    def hybrid(self, query: str, *, fuse_k: int) -> tuple[list[int], Usage]:
        """Reciprocal-rank fusion of dense and sparse rankings.

        RRF needs no score normalization between the two systems, which is why
        it is the fusion you want when one side is cosine similarity and the
        other is BM25 — their scales are not comparable.
        """
        dense_ids, usage = self.dense(query, fuse_k)
        sparse_ids = self.sparse(query, fuse_k)
        fused: dict[int, float] = {}
        for ranking in (dense_ids, sparse_ids):
            for rank, idx in enumerate(ranking):
                fused[idx] = fused.get(idx, 0.0) + 1.0 / (RRF_K + rank + 1)
        order = sorted(fused, key=lambda i: -fused[i])
        return order[:fuse_k], usage
