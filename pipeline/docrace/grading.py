"""Pre-grading the preset results against committed ground truth.

The deployed site never grades anything — grades are computed once here, offline,
and committed as JSON. A judge model does the first pass; the rationale is kept
alongside each grade so a wrong call is visible and can be overridden by hand
before the results are committed.

The grade vocabulary matters for the absence row. "Correctly refused" has to be
distinct from "incorrect", because an arm that says "the document does not
address this" when the document indeed does not is doing the right thing, and an
arm that produces a confident number instead is doing the single worst thing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .client import anthropic_client
from .pricing import Usage
from .questions import Question

JUDGE_MODEL = "claude-opus-5"

GRADES: tuple[str, ...] = (
    "correct",
    "partial",
    "incorrect",
    "hallucinated",
    "correctly_refused",
)

GRADE_META: dict[str, dict[str, str]] = {
    "correct": {"label": "Correct", "credit": "1.0"},
    "partial": {"label": "Partial", "credit": "0.5"},
    "incorrect": {"label": "Incorrect", "credit": "0.0"},
    "hallucinated": {"label": "Hallucinated", "credit": "0.0"},
    "correctly_refused": {"label": "Correctly refused", "credit": "1.0"},
}

CREDIT: dict[str, float] = {
    "correct": 1.0,
    "correctly_refused": 1.0,
    "partial": 0.5,
    "incorrect": 0.0,
    "hallucinated": 0.0,
}

SYSTEM = (
    "You grade one answer against a reference answer for a question about a "
    "document. You do not have the document; the reference answer is "
    "authoritative.\n\n"
    "Grades:\n"
    "- correct: the answer states the substance of the reference answer. Different "
    "wording, extra correct detail, and a different order are all fine.\n"
    "- partial: the answer gets some of the reference answer right but omits a "
    "material part, or is right in substance while wrong on a figure or count.\n"
    "- incorrect: the answer contradicts the reference answer, or declines to "
    "answer a question the document does in fact answer.\n"
    "- hallucinated: the answer asserts specifics the reference answer shows to be "
    "fabricated — a value, provision, count, or citation that does not exist. Use "
    "this rather than 'incorrect' when the answer is not merely wrong but "
    "confidently invents content. This is the grade for answering an unanswerable "
    "question with a specific claim.\n"
    "- correctly_refused: the question has no answer in the document, and the "
    "answer says so, or says the material available is insufficient. This is a "
    "success, not a failure.\n\n"
    "For a question whose reference answer says the document does not address it, "
    "the only good grades are correctly_refused, or partial if the answer hedges "
    "toward a specific claim while noting uncertainty. An answer that supplies a "
    "confident specific is hallucinated.\n\n"
    "Judge only against the reference answer. Do not reward or penalize style, "
    "length, or the presence of citations."
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "grade": {"type": "string", "enum": list(GRADES)},
        "rationale": {
            "type": "string",
            "description": "One sentence naming what the answer got right or wrong.",
        },
    },
    "required": ["grade", "rationale"],
    "additionalProperties": False,
}


@dataclass
class Grade:
    grade: str
    rationale: str
    usage: Usage

    def to_dict(self) -> dict:
        return {"grade": self.grade, "rationale": self.rationale}


def grade_answer(question: Question, answer: str) -> Grade:
    if not answer.strip():
        return Grade(
            grade="incorrect",
            rationale="The arm produced no answer.",
            usage=Usage(),
        )

    prompt = (
        f"<question type=\"{question.type}\">\n{question.question}\n</question>\n\n"
        f"<reference_answer>\n{question.ground_truth}\n</reference_answer>\n\n"
        f"<grading_notes>\n{question.grading_notes or '(none)'}\n</grading_notes>\n\n"
        f"<answer_under_test>\n{answer}\n</answer_under_test>"
    )
    message = anthropic_client().messages.create(
        model=JUDGE_MODEL,
        max_tokens=2_000,
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
    )
    if message.stop_reason == "refusal":
        return Grade(
            grade="incorrect",
            rationale="Judge declined to grade this pair; review by hand.",
            usage=Usage.from_message_usage(message.usage),
        )
    payload = json.loads(next(b.text for b in message.content if b.type == "text"))
    return Grade(
        grade=payload["grade"],
        rationale=payload["rationale"].strip(),
        usage=Usage.from_message_usage(message.usage),
    )
