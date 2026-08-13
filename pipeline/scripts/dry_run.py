#!/usr/bin/env python3
"""Exercise every arm against a stubbed API, spending nothing.

The point is to catch plumbing bugs — a malformed request, a tool loop that
never terminates, usage that fails to accumulate across calls, a delta clock
that resets mid-loop — before a real run costs real money. It asserts on
behaviour rather than printing for a human to eyeball, so it can be run again
after any change to the arms.

Usage:  python scripts/dry_run.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from docrace import client as client_mod  # noqa: E402
from docrace import contextual, retrieval  # noqa: E402
from docrace.arms import agentic, cached_context, extract, full_context  # noqa: E402
from docrace.arms import hybrid_rag, naive_rag  # noqa: E402
from docrace.chunking import chunk_document  # noqa: E402
from docrace.retrieval import Index  # noqa: E402

DOCUMENT = "\n\n".join(
    [
        "MASTER SERVICES AGREEMENT",
        "Section 1. Definitions. 'Term' means the period described in Section 3.",
        "Section 2. Governing Law. This Agreement is governed by the laws of Delaware.",
        "Section 3. Term. The initial term is three years from the Effective Date.",
        "Section 4. Termination for Cause. Either party may terminate on 30 days notice.",
        "Section 5. Termination for Convenience. Customer may terminate on 90 days notice.",
        "Section 6. Fees. Customer shall pay $250,000 annually, invoiced quarterly.",
        "Section 7. Liability. Aggregate liability is capped at fees paid in 12 months.",
    ]
)

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


@dataclass
class StubUsage:
    input_tokens: int = 1_000
    output_tokens: int = 120
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_creation: Any = None


@dataclass
class StubTextBlock:
    text: str
    type: str = "text"


@dataclass
class StubToolUse:
    id: str
    name: str
    input: dict
    type: str = "tool_use"


class StubMessage:
    def __init__(self, content, usage=None, stop_reason="end_turn"):
        self.content = content
        self.usage = usage or StubUsage()
        self.stop_reason = stop_reason
        self.stop_details = None


class StubDeltaEvent:
    def __init__(self, text: str):
        self.type = "content_block_delta"
        self.delta = type("D", (), {"type": "text_delta", "text": text})()


class StubStream:
    def __init__(self, message: StubMessage):
        self._message = message

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        for block in self._message.content:
            if getattr(block, "type", "") == "text":
                for word in block.text.split(" "):
                    yield StubDeltaEvent(word + " ")

    def get_final_message(self):
        return self._message


class StubMessages:
    """Records every request so the harness can assert on request shape."""

    def __init__(self, owner: "StubClient"):
        self.owner = owner

    def stream(self, **kwargs):
        self.owner.requests.append(kwargs)
        return StubStream(self.owner.next_message(kwargs))

    def create(self, **kwargs):
        self.owner.requests.append(kwargs)
        return self.owner.next_message(kwargs)

    def count_tokens(self, **kwargs):
        text = str(kwargs.get("messages", ""))
        return type("R", (), {"input_tokens": len(text) // 4})()


class StubClient:
    def __init__(self):
        self.requests: list[dict] = []
        self.messages = StubMessages(self)
        self.tool_turns = 0

    def next_message(self, kwargs: dict) -> StubMessage:
        # Structured-output calls must get parseable JSON back.
        fmt = (kwargs.get("output_config") or {}).get("format")
        if fmt:
            schema = fmt["schema"]
            props = schema.get("properties", {})
            if "prefixes" in props:
                # One prefix per excerpt in the prompt, keyed by its index.
                prompt = str(kwargs["messages"][0]["content"])
                indexes = [
                    int(part.split('"')[0])
                    for part in prompt.split('index="')[1:]
                ]
                body = {
                    "prefixes": [
                        {"index": i, "context": f"Context for chunk {i}."}
                        for i in indexes
                    ]
                }
            elif "grade" in props:
                body = {"grade": "correct", "rationale": "Stub grade."}
            else:
                body = {"agreement_title": "MASTER SERVICES AGREEMENT", "parties": []}
            import json

            return StubMessage([StubTextBlock(json.dumps(body))])

        # The agentic arm gets two tool turns and then a final answer, so both the
        # loop and its termination are exercised.
        if kwargs.get("tools"):
            self.tool_turns += 1
            if self.tool_turns == 1:
                return StubMessage(
                    [
                        StubTextBlock("Let me search for the termination provisions."),
                        StubToolUse("t1", "grep", {"pattern": "[Tt]ermination"}),
                    ],
                    stop_reason="tool_use",
                )
            if self.tool_turns == 2:
                return StubMessage(
                    [StubToolUse("t2", "read_lines", {"start": 1, "end": 20})],
                    stop_reason="tool_use",
                )
            return StubMessage([StubTextBlock("There are two termination rights.")])

        return StubMessage([StubTextBlock("Delaware law governs this agreement.")])


def stub_embed(texts: list[str], *, input_type: str):
    from docrace.pricing import Usage

    assert input_type in ("document", "query"), input_type
    rng = np.random.default_rng(0)
    arr = rng.normal(size=(len(texts), 16)).astype(np.float32)
    arr /= np.linalg.norm(arr, axis=1, keepdims=True)
    return arr, Usage(embed_tokens=sum(len(t) // 4 for t in texts))


def stub_rerank(query: str, documents: list[str], top_k: int):
    from docrace.pricing import Usage

    ranked = [(i, 1.0 - i * 0.01) for i in range(min(top_k, len(documents)))]
    return ranked, Usage(rerank_tokens=sum(len(d) // 4 for d in documents))


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}{': ' + detail if detail else ''}")
        raise SystemExit(1)


UNSUPPORTED_KEYWORDS = (
    "minimum",
    "maximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
)


def validate_schemas() -> None:
    """Check every schema against the structured-output constraints.

    Structured outputs reject objects without `additionalProperties: false`, and
    silently ignore numeric and string constraints. A schema problem would
    otherwise surface as a 400 partway through a paid run.
    """
    import json

    from docrace import grading
    from docrace.paths import SCHEMAS

    def walk(node: Any, path: str, problems: list[str]) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "object":
            if node.get("additionalProperties") is not False:
                problems.append(f"{path}: object is missing additionalProperties:false")
            for key, value in (node.get("properties") or {}).items():
                walk(value, f"{path}.{key}", problems)
        if node.get("type") == "array":
            walk(node.get("items") or {}, f"{path}[]", problems)
        for keyword in UNSUPPORTED_KEYWORDS:
            if keyword in node:
                problems.append(f"{path}: unsupported keyword {keyword!r}")

    targets: list[tuple[str, Any]] = [
        (path.stem, json.loads(path.read_text())) for path in sorted(SCHEMAS.glob("*.json"))
    ]
    targets += [("contextual", contextual.SCHEMA), ("grading", grading.SCHEMA)]

    print("\nschemas")
    for name, schema in targets:
        problems: list[str] = []
        walk(schema, name, problems)
        check(f"{name} schema is valid for structured outputs", not problems, "; ".join(problems))


def main() -> None:
    validate_schemas()

    stub = StubClient()
    client_mod.anthropic_client.cache_clear()
    client_mod.anthropic_client = lambda: stub  # type: ignore[assignment]
    for module in (contextual, extract, __import__("docrace.grading", fromlist=["x"])):
        module.anthropic_client = lambda: stub  # type: ignore[attr-defined]
    for module in (retrieval,):
        module.embed = stub_embed  # type: ignore[attr-defined]
    from docrace.arms import base as base_mod

    base_mod.anthropic_client = lambda: stub  # type: ignore[attr-defined]
    hybrid_rag.rerank = stub_rerank  # type: ignore[attr-defined]

    chunks = [c.text for c in chunk_document(DOCUMENT)]
    print(f"\nchunking: {len(chunks)} chunk(s) from {len(DOCUMENT)} chars")
    check("chunker produced chunks", len(chunks) > 0)

    index = Index.build(chunks)
    check("index embedded every chunk", index.vectors.shape[0] == len(chunks))
    check("index recorded build usage", index.build_usage.embed_tokens > 0)

    print("\narm 1 — full context")
    r1 = full_context.run(
        doc_id="stub", document=DOCUMENT, question_id="q1", question="Governing law?"
    )
    check("answer captured", bool(r1.answer))
    check("deltas captured with timings", len(r1.deltas) > 0 and r1.deltas[0][0] >= 0)
    check("delta timings are non-decreasing", all(
        r1.deltas[i][0] <= r1.deltas[i + 1][0] for i in range(len(r1.deltas) - 1)
    ))
    check("cost derived from usage", r1.cost.total > 0)
    check("no cache breakpoint sent", "cache_control" not in str(stub.requests[-1]))

    print("\narm 2 — cached context, both cache lifetimes")
    for ttl in cached_context.TTLS:
        r2 = cached_context.run(
            doc_id="stub",
            document=DOCUMENT,
            question_id="q1",
            question="Governing law?",
            ttl=ttl,
        )
        req = stub.requests[-1]
        breakpoints = [
            block
            for block in req["system"]
            if isinstance(block, dict) and "cache_control" in block
        ]
        check(f"{ttl}: exactly one breakpoint", len(breakpoints) == 1)
        check(
            f"{ttl}: breakpoint is on the document block",
            "<document>" in breakpoints[0]["text"],
        )
        check(
            f"{ttl}: breakpoint carries the requested ttl",
            breakpoints[0]["cache_control"].get("ttl") == ttl,
        )
        check(
            f"{ttl}: question sits after the breakpoint, in messages",
            "Governing law?" in str(req["messages"])
            and "Governing law?" not in str(req["system"]),
        )
        check(f"{ttl}: arm id records the lifetime", r2.arm.endswith(ttl))
        check(f"{ttl}: notes record cache state", "cache_hit" in r2.notes)
    five_m, one_h = stub.requests[-2], stub.requests[-1]

    def _document(req: dict) -> str:
        return next(
            b.get("text", "")
            for b in req["system"]
            if b.get("text", "").startswith("<document>")
        )

    def _cache_key(req: dict) -> str:
        # The cache is keyed on the bytes of the prefix, so that is what has to
        # differ — every system block, since the breakpoint sits on the last one.
        return "".join(b.get("text", "") for b in req["system"])

    check(
        "the two variants send the same document",
        _document(five_m) == _document(one_h),
    )
    check(
        # The variants used to send byte-identical prompts, which meant one cache
        # entry between them: whichever ran second read the first one's still-live
        # entry, was never billed a write, and reported its warm as costing $0 —
        # the y-intercept the cost chart is built on. They now carry a lifetime
        # marker so each keys its own entry and pays its own warm.
        "the two variants cache under different keys",
        _cache_key(five_m) != _cache_key(one_h),
    )

    print("\narm 3 — naive rag")
    r3 = naive_rag.run(
        doc_id="stub", index=index, question_id="q1", question="Governing law?"
    )
    check("retrieved chunks recorded", len(r3.notes["retrieved_chunks"]) > 0)
    check(
        "retrieval cost folded into total",
        r3.usage.embed_tokens > 0 and r3.cost.embed > 0,
    )
    check(
        "document not sent wholesale",
        len(str(stub.requests[-1]["messages"])) < len(DOCUMENT) + 2_000,
    )

    print("\narm 4 — hybrid rag with contextual prefixes")
    prefixed, ctx_usage = contextual.build_contextual_chunks(DOCUMENT, chunks)
    check("one prefixed chunk per chunk", len(prefixed) == len(chunks))
    check("prefixes were prepended", prefixed[0].startswith("Context for chunk 0."))
    check("indexing usage recorded", ctx_usage.calls > 0)
    ctx_index = Index.build(prefixed)
    r4 = hybrid_rag.run(
        doc_id="stub", index=ctx_index, question_id="q1", question="Governing law?"
    )
    check("fused candidates recorded", len(r4.notes["fused_candidates"]) > 0)
    check("rerank cost folded in", r4.usage.rerank_tokens > 0)

    print("\narm 5 — agentic search")
    stub.tool_turns = 0
    r5 = agentic.run(
        doc_id="stub",
        document=DOCUMENT,
        question_id="q1",
        question="How many termination rights?",
    )
    check("loop terminated", r5.notes["iterations"] == 3)
    check("did not hit the iteration cap", not r5.notes["hit_iteration_cap"])
    check("both tools were exercised", {c["tool"] for c in r5.notes["tool_calls"]} == {"grep", "read_lines"})
    check("usage summed across the whole loop", r5.usage.calls == 3)
    check(
        "delta clock spans the loop rather than resetting",
        len(r5.deltas) > 0 and r5.deltas[-1][0] >= r5.deltas[0][0],
    )
    check("final answer is the last turn's text", "termination rights" in r5.answer)

    # The growing conversation must be cached, or this arm pays full input price
    # for the same tool output on every iteration.
    agentic_requests = [r for r in stub.requests if r.get("tools")]
    later_turns = [r for r in agentic_requests if len(r["messages"]) > 1]
    check("the loop ran more than one turn", len(later_turns) >= 1)
    for i, req in enumerate(later_turns):
        annotated = [
            block
            for message in req["messages"]
            if isinstance(message["content"], list)
            for block in message["content"]
            if isinstance(block, dict) and "cache_control" in block
        ]
        check(f"turn {i + 2}: conversation prefix carries a breakpoint", len(annotated) >= 1)
        check(
            f"turn {i + 2}: within the four-breakpoint limit",
            len(annotated) <= 4,
        )
        check(
            f"turn {i + 2}: breakpoints only on tool_result blocks",
            all(block.get("type") == "tool_result" for block in annotated),
        )
    # Assistant turns are echoed back verbatim; annotating them would mean editing
    # thinking blocks, which the API rejects.
    check(
        "no breakpoint on an assistant turn",
        not any(
            isinstance(block, dict) and "cache_control" in block
            for req in agentic_requests
            for message in req["messages"]
            if message["role"] == "assistant" and isinstance(message["content"], list)
            for block in message["content"]
            if isinstance(block, dict)
        ),
    )

    print("\narm 6 — extract then query")
    extraction, ex_usage = extract.build_extraction(DOCUMENT, "legal")
    check("extraction returned a record", isinstance(extraction, dict))
    check("extraction usage recorded", ex_usage.calls > 0)
    r6 = extract.run(
        doc_id="stub", extraction=extraction, question_id="q1", question="Governing law?"
    )
    check("record sent, document not", "MASTER SERVICES AGREEMENT" in str(stub.requests[-1]))
    # The record is identical for every question, so it needs its own content block
    # to hold a breakpoint. Concatenated with the question there is nowhere to put
    # one and the record is re-billed at full price every time.
    blocks = stub.requests[-1]["messages"][0]["content"]
    check("record and question are separate blocks", isinstance(blocks, list) and len(blocks) == 2)
    check("breakpoint is on the record block", "cache_control" in blocks[0])
    check("question block carries no breakpoint", "cache_control" not in blocks[1])
    check("question is not inside the cached block", "Governing law?" not in blocks[0]["text"])
    check("notes record cache state", "cache_hit" in r6.notes)

    print("\ngrading")
    from docrace.grading import grade_answer
    from docrace.questions import Question

    q = Question(
        id="q1",
        doc_id="stub",
        type="needle",
        question="Governing law?",
        ground_truth="Delaware.",
        grading_notes="",
    )
    g = grade_answer(q, r1.answer)
    check("grade returned", g.grade == "correct")
    empty = grade_answer(q, "   ")
    check("empty answer graded without an API call", empty.grade == "incorrect")

    print("\ntool implementations")
    lines = DOCUMENT.split("\n")
    check("grep finds matches", "Termination" in agentic._grep(lines, "Termination"))
    check("grep reports no matches cleanly", agentic._grep(lines, "zzz") == "No matches.")
    check("grep survives a bad regex", "Invalid" in agentic._grep(lines, "[("))
    check("read_lines clamps a past-the-end range", "1:" in agentic._read_lines(lines, 1, 9_999))
    check("read_lines rejects an inverted range", "Empty range" in agentic._read_lines(lines, 20, 2))

    total_calls = sum(
        r.usage.calls for r in (r1, r2, r3, r4, r5, r6)
    ) + ctx_usage.calls + ex_usage.calls
    print(f"\nall checks passed — {len(stub.requests)} stubbed requests, "
          f"{total_calls} arm/index calls accounted for")


if __name__ == "__main__":
    main()
