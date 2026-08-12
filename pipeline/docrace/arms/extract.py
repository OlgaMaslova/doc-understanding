"""Arm 6 — extract then query.

One map-reduce pass over the document fills a schema; every query afterwards hits
the structured output instead of the document. Marginal cost per query is close
to zero and aggregation is trivial, because counting termination rights is
`len(termination_rights)` rather than a retrieval problem.

The catch is the schema. This arm answers what the schema anticipated and nothing
else, which reframes the question from "which strategy is best" to "do you know
your questions in advance?" — the decision most teams are actually facing. The
schemas in data/schemas/ are deliberately what a competent engineer would write
before seeing the questions, not reverse-engineered from them.
"""

from __future__ import annotations

import json
from typing import Any

from ..client import anthropic_client
from ..paths import SCHEMAS
from ..pricing import ARM_MODEL, INDEX_MODEL, Usage
from .base import (
    ArmResult,
    refusal_guard,
    result_from,
    stream_answer,
    truncation_note,
)

ARM = "extract"

# Windows are large because the models have room for them; overlap keeps a fact
# that straddles a boundary from being dropped by both windows.
WINDOW_CHARS = 120_000
WINDOW_OVERLAP_CHARS = 4_000

# The extracted record is byte-identical for every question about a document, so
# it is worth a cache breakpoint. The 1-hour write costs 2x input rather than
# 1.25x, but the record is a few thousand tokens so the difference is fractions of
# a cent, and it removes any chance of the cache lapsing partway through a run and
# quietly re-billing the record at full price.
CACHE_TTL = "1h"

EXTRACT_SYSTEM = (
    "You extract structured facts from a document into a fixed schema.\n\n"
    "Fill every field the material supports, quoting figures and dates exactly as "
    "written. Leave a field empty rather than inferring a value the document does "
    "not state. For list fields, include every distinct item you find — "
    "completeness matters more than brevity, and a missing entry is a wrong "
    "answer later."
)

MERGE_SYSTEM = (
    "You merge partial extractions of one document into a single record.\n\n"
    "Union the list fields, dropping exact and near duplicates that describe the "
    "same item. Keep the more specific value when two extractions disagree on a "
    "scalar, and keep both with their qualifiers when they describe genuinely "
    "different things. Do not add anything that is not present in the inputs."
)

QUERY_SYSTEM = (
    "You answer questions from a structured extraction of a document. The "
    "extraction is all you have — the document itself is not available.\n\n"
    "Answer from the record's contents. When the record has a list that bears on "
    "the question, use the whole list. If the record has no field covering the "
    "question, say that the extraction schema does not capture it — do not guess "
    "from adjacent fields, and do not treat an empty field as proof the document "
    "is silent unless the schema would clearly have captured it."
)


def load_schema(domain: str) -> dict[str, Any]:
    path = SCHEMAS / f"{domain}.json"
    if not path.exists():
        raise FileNotFoundError(f"No extraction schema for domain {domain!r} at {path}")
    return json.loads(path.read_text())


def _windows(document: str) -> list[str]:
    if len(document) <= WINDOW_CHARS:
        return [document]
    out: list[str] = []
    step = WINDOW_CHARS - WINDOW_OVERLAP_CHARS
    for start in range(0, len(document), step):
        chunk = document[start : start + WINDOW_CHARS]
        if chunk.strip():
            out.append(chunk)
        if start + WINDOW_CHARS >= len(document):
            break
    return out


def _check_complete(message, label: str) -> None:
    """A truncated structured output is invalid JSON; fail with the cause."""
    if message.stop_reason != "end_turn":
        raise RuntimeError(
            f"{label} stopped with {message.stop_reason!r} instead of completing; "
            f"the structured output is unusable. If this is 'max_tokens', the "
            f"schema is eliciting more output than the budget allows."
        )


def build_extraction(
    document: str, domain: str, *, progress=None
) -> tuple[dict[str, Any], Usage]:
    """Map-reduce the document into the domain schema. This is the fixed cost."""
    client = anthropic_client()
    schema = load_schema(domain)
    output_config = {"format": {"type": "json_schema", "schema": schema}}
    total = Usage()

    windows = _windows(document)
    partials: list[dict[str, Any]] = []

    for i, window in enumerate(windows):
        with client.messages.stream(
            model=INDEX_MODEL,
            max_tokens=64_000,
            system=EXTRACT_SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"<document_part index=\"{i + 1}\" of=\"{len(windows)}\">\n"
                        f"{window}\n</document_part>\n\n"
                        "Extract everything this part supports."
                    ),
                }
            ],
            output_config=output_config,
        ) as stream:
            message = stream.get_final_message()
        _check_complete(message, f"extraction window {i + 1}/{len(windows)}")
        total = total + Usage.from_message_usage(message.usage)
        partials.append(
            json.loads(next(b.text for b in message.content if b.type == "text"))
        )
        if progress:
            progress(i + 1, len(windows))

    if len(partials) == 1:
        return partials[0], total

    joined = "\n\n".join(
        f'<extraction index="{i + 1}">\n{json.dumps(p, indent=2)}\n</extraction>'
        for i, p in enumerate(partials)
    )
    with client.messages.stream(
        model=INDEX_MODEL,
        max_tokens=64_000,
        system=MERGE_SYSTEM,
        messages=[{"role": "user", "content": f"{joined}\n\nMerge these into one record."}],
        output_config=output_config,
    ) as stream:
        message = stream.get_final_message()
    _check_complete(message, "extraction merge")
    total = total + Usage.from_message_usage(message.usage)
    merged = json.loads(next(b.text for b in message.content if b.type == "text"))
    return merged, total


def run(
    *,
    doc_id: str,
    extraction: dict[str, Any],
    question_id: str,
    question: str,
) -> ArmResult:
    record = json.dumps(extraction, indent=2)
    capture = stream_answer(
        system=QUERY_SYSTEM,
        # The record and the question are separate content blocks so there is a
        # breakpoint position between them. Concatenated into one block — which is
        # the obvious way to write this — there is nowhere to put the breakpoint,
        # and the record is re-billed at full price on every question even though
        # it is byte-identical across all of them.
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"<record>\n{record}\n</record>",
                        "cache_control": {"type": "ephemeral", "ttl": CACHE_TTL},
                    },
                    {"type": "text", "text": f"Question: {question}"},
                ],
            }
        ],
        cache_ttl=CACHE_TTL,
    )
    refusal_guard(capture)
    return result_from(
        arm=ARM,
        doc_id=doc_id,
        question_id=question_id,
        capture=capture,
        notes={
            "context": "structured extraction only; document not available",
            "extraction_chars": len(record),
            "cache_ttl": CACHE_TTL,
            # A small extraction can fall below the minimum cacheable prefix, in
            # which case nothing is cached and no error is raised. Recording the
            # hit makes that visible rather than silent.
            "cache_hit": capture.usage.cache_read_tokens > 0,
            **truncation_note(capture),
        },
        model=ARM_MODEL,
    )
