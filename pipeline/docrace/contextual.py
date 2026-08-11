"""Contextual retrieval: LLM-written situating prefixes for each chunk.

A chunk pulled out of a 10-K reads like "revenue increased 12% to $4.2 billion"
with no way to know whose revenue, which segment, or which year — so embedding
and BM25 both fail to match a query that names any of those. A one-sentence
prefix written with the whole document in view fixes that, and it is the single
biggest reason arm 4 recovers most of naive RAG's losses.

This is the real indexing bill: it scales with document size and it is paid
before the first query. It shows up as arm 4's y-intercept on the cost chart.

Implementation notes that matter for cost:
- The document is sent once as a cached prefix and read back on every batch.
- Chunks are batched, so a 400-chunk document is ~20 calls rather than 400.
- Structured outputs guarantee we get back exactly one prefix per chunk, keyed
  by index, instead of prose we would have to parse.
"""

from __future__ import annotations

import json
from typing import Any

from .client import anthropic_client
from .pricing import INDEX_MODEL, Usage

BATCH = 20
CACHE_TTL = "1h"

SYSTEM = (
    "You situate excerpts within a document so they can be retrieved on their own.\n\n"
    "For each excerpt, write one or two sentences of context that a search "
    "system would need in order to match the excerpt to a relevant question. "
    "Name the entities, the section or agreement the excerpt belongs to, the "
    "time period, and what the excerpt is about. Resolve pronouns and defined "
    "terms to the things they refer to.\n\n"
    "Describe the excerpt's place in the document. Do not summarize its content "
    "in place of situating it, and do not add facts from elsewhere in the "
    "document that the excerpt does not touch on."
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "prefixes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "context": {"type": "string"},
                },
                "required": ["index", "context"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["prefixes"],
    "additionalProperties": False,
}


def _batch_prompt(batch: list[tuple[int, str]]) -> str:
    parts = [
        f'<excerpt index="{idx}">\n{text}\n</excerpt>' for idx, text in batch
    ]
    return (
        "\n\n".join(parts)
        + "\n\nWrite a situating context for each excerpt above. Return one entry "
        "per excerpt, using the same index."
    )


def build_contextual_chunks(
    document: str, chunk_texts: list[str], *, progress=None
) -> tuple[list[str], Usage]:
    """Return prefixed chunk texts plus the indexing usage that produced them."""
    client = anthropic_client()
    system = [
        {"type": "text", "text": SYSTEM},
        {
            "type": "text",
            "text": f"<document>\n{document}\n</document>",
            "cache_control": {"type": "ephemeral", "ttl": CACHE_TTL},
        },
    ]

    contexts: dict[int, str] = {}
    total = Usage()

    for start in range(0, len(chunk_texts), BATCH):
        batch = [
            (i, chunk_texts[i])
            for i in range(start, min(start + BATCH, len(chunk_texts)))
        ]
        message = client.messages.create(
            model=INDEX_MODEL,
            max_tokens=4_000,
            system=system,
            messages=[{"role": "user", "content": _batch_prompt(batch)}],
            output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
        )
        total = total + Usage.from_message_usage(message.usage, ttl=CACHE_TTL)

        text = next(b.text for b in message.content if b.type == "text")
        for entry in json.loads(text)["prefixes"]:
            contexts[int(entry["index"])] = entry["context"].strip()

        if progress:
            progress(min(start + BATCH, len(chunk_texts)), len(chunk_texts))

    prefixed: list[str] = []
    for i, chunk in enumerate(chunk_texts):
        ctx = contexts.get(i)
        # A missing prefix would silently make one chunk worse than its
        # neighbours; fall back to the bare chunk and say so rather than
        # pretending the index is uniform.
        prefixed.append(f"{ctx}\n\n{chunk}" if ctx else chunk)

    missing = [i for i in range(len(chunk_texts)) if i not in contexts]
    if missing:
        print(
            f"  warning: {len(missing)} chunk(s) got no contextual prefix "
            f"(indexes {missing[:10]}{'...' if len(missing) > 10 else ''})"
        )

    return prefixed, total
