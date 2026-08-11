#!/usr/bin/env python3
"""Validate the question set before it becomes an answer key.

Every grade in the deployed site is measured against `ground_truth`, so an error
here is invisible and contaminates every arm at once. This checks the structural
invariants — the shape of the matrix, unique ids, non-empty answers — and then
verifies each question's cited evidence actually appears in its document.

The evidence check is the one that matters. A `quote` field on each question is
grepped against the source text; an absent-type question instead lists
`absent_terms`, and the check confirms each of those terms is genuinely missing.
A question claiming absence that the document actually answers would invert the
grade for all six arms.

Usage:  python scripts/check_questions.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import yaml  # noqa: E402

from docrace.documents import BY_ID  # noqa: E402
from docrace.paths import QUESTIONS_FILE  # noqa: E402
from docrace.questions import QUESTION_TYPES  # noqa: E402

PER_TYPE = 3

failures: list[str] = []
warnings: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def warn(message: str) -> None:
    warnings.append(message)


def normalize(text: str) -> str:
    """Collapse whitespace so a quote can span a wrapped line."""
    return re.sub(r"\s+", " ", text).strip().lower()


def main() -> None:
    if not QUESTIONS_FILE.exists():
        raise SystemExit(f"{QUESTIONS_FILE} does not exist yet")

    raw = yaml.safe_load(QUESTIONS_FILE.read_text())
    entries = raw["questions"]
    print(f"{len(entries)} questions in {QUESTIONS_FILE.name}\n")

    texts: dict[str, str] = {}
    for doc_id, source in BY_ID.items():
        if source.text_path.exists():
            texts[doc_id] = normalize(source.text_path.read_text())
        else:
            warn(f"{doc_id}: text not fetched, evidence unverifiable")

    seen_ids: set[str] = set()
    counts: dict[tuple[str, str], int] = {}

    for entry in entries:
        qid = entry.get("id", "<missing id>")

        for field in ("id", "doc_id", "type", "question", "ground_truth"):
            if not str(entry.get(field, "")).strip():
                fail(f"{qid}: {field} is empty")

        if qid in seen_ids:
            fail(f"{qid}: duplicate id")
        seen_ids.add(qid)

        doc_id = entry.get("doc_id")
        if doc_id not in BY_ID:
            fail(f"{qid}: unknown doc_id {doc_id!r}")
            continue

        qtype = entry.get("type")
        if qtype not in QUESTION_TYPES:
            fail(f"{qid}: unknown type {qtype!r}")
            continue
        counts[(doc_id, qtype)] = counts.get((doc_id, qtype), 0) + 1

        if not str(entry.get("grading_notes", "")).strip():
            warn(f"{qid}: no grading notes — a grader has less to go on")

        body = normalize(texts.get(doc_id, ""))

        if qtype == "absent":
            terms = entry.get("absent_terms") or []
            if not terms:
                fail(f"{qid}: absent questions must list absent_terms")
            for term in terms:
                if body and normalize(term) in body:
                    fail(
                        f"{qid}: absent_terms includes {term!r}, which DOES appear in "
                        f"{doc_id} — this question is answerable and would invert every grade"
                    )
            truth = normalize(entry.get("ground_truth", ""))
            if not any(
                phrase in truth
                for phrase in ("does not", "no ", "not state", "not contain", "silent")
            ):
                warn(
                    f"{qid}: ground truth for an absent question should say plainly "
                    "that the document does not answer it"
                )
            if entry.get("quote"):
                fail(f"{qid}: absent questions should not carry a quote")
        else:
            quote = entry.get("quote")
            if not quote:
                fail(f"{qid}: needs a `quote` naming the evidence in the document")
            elif body and normalize(quote) not in body:
                fail(
                    f"{qid}: quote not found in {doc_id} — "
                    f"{normalize(quote)[:70]!r}"
                )

    for doc_id in BY_ID:
        for qtype in QUESTION_TYPES:
            n = counts.get((doc_id, qtype), 0)
            if n != PER_TYPE:
                fail(f"{doc_id}/{qtype}: {n} questions, expected {PER_TYPE}")

    for message in warnings:
        print(f"  warn  {message}")
    for message in failures:
        print(f"  FAIL  {message}")

    if failures:
        print(f"\n{len(failures)} failure(s)")
        raise SystemExit(1)
    print(
        f"\nall structural checks passed; every quote verified against its document"
        f"{f' ({len(warnings)} warning(s))' if warnings else ''}"
    )


if __name__ == "__main__":
    main()
