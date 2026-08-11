"""The preset question set and its taxonomy.

The five types are the second axis of the heatmap and where the real
differentiation lives. Needle questions establish the floor — everything passes.
The interesting cells are aggregation and absence, because retrieval always
returns something, and something is what gets hallucinated from.
"""

from __future__ import annotations

from dataclasses import dataclass

import yaml

from .paths import QUESTIONS_FILE

QUESTION_TYPES: tuple[str, ...] = (
    "needle",
    "multi_hop",
    "aggregation",
    "global",
    "absent",
)

TYPE_META: dict[str, dict[str, str]] = {
    "needle": {
        "label": "Needle",
        "why": "One passage contains the answer. Everything passes; this establishes the floor.",
    },
    "multi_hop": {
        "label": "Multi-hop",
        "why": "Requires joining facts from distant sections. Retrieval usually gets one hop.",
    },
    "aggregation": {
        "label": "Aggregation",
        "why": "Requires seeing the whole document. Top-k retrieval structurally cannot.",
    },
    "global": {
        "label": "Global",
        "why": "No single passage contains the answer; it is a property of the document.",
    },
    "absent": {
        "label": "Absent",
        "why": "The answer is not in the document. Tests refusal against hallucination.",
    },
}


@dataclass(frozen=True)
class Question:
    id: str
    doc_id: str
    type: str
    question: str
    ground_truth: str
    grading_notes: str
    # The passage in the document the reference answer rests on, verified verbatim
    # by scripts/check_questions.py. Empty for `absent` questions, which by
    # definition have nothing to quote — their provenance is `absent_terms`, the
    # list of phrases confirmed *not* to appear.
    quote: str = ""
    absent_terms: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "doc_id": self.doc_id,
            "type": self.type,
            "question": self.question,
            "ground_truth": self.ground_truth,
            "grading_notes": self.grading_notes,
            # Carried into the results so the site can show its own answer key.
            # A tool whose pitch is "don't take a blog post's word for it" cannot
            # then ask the reader to take its grades on faith.
            "quote": self.quote,
            "absent_terms": list(self.absent_terms),
        }


def load_questions(doc_id: str | None = None) -> list[Question]:
    raw = yaml.safe_load(QUESTIONS_FILE.read_text())
    out: list[Question] = []
    for entry in raw["questions"]:
        if entry["type"] not in QUESTION_TYPES:
            raise ValueError(f"{entry['id']}: unknown question type {entry['type']!r}")
        # `quote` and `absent_terms` are provenance for the ground truth, not
        # inputs to grading — the judge never sees them. They are carried through
        # to the results so the UI can show what the reference answer rests on.
        q = Question(
            id=entry["id"],
            doc_id=entry["doc_id"],
            type=entry["type"],
            question=entry["question"].strip(),
            ground_truth=entry["ground_truth"].strip(),
            grading_notes=entry.get("grading_notes", "").strip(),
            quote=(entry.get("quote") or "").strip(),
            absent_terms=tuple(entry.get("absent_terms") or ()),
        )
        if doc_id is None or q.doc_id == doc_id:
            out.append(q)
    ids = [q.id for q in out]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate question ids in questions.yaml")
    return out
