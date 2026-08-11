"""Arm 5 — agentic search.

The model gets grep and read tools over the document and iterates: search, read
what it found, search again. It never needs the whole document in context, and
it is the only arm that can follow a chain of references across distant sections
under its own steam — which is why it holds up on multi-hop.

It is also the slowest by a wide margin, and its cost varies per question rather
than being a fixed rate. That variance is a finding, not noise, so usage is
summed across the whole loop and the per-question call count is recorded.

This arm uses a manual tool loop rather than the SDK tool runner because it needs
delta timings measured against a single clock spanning every call in the loop —
that is what replay mode reproduces. The runner owns its own iteration and does
not expose a shared stream clock.
"""

from __future__ import annotations

import re
import time
from typing import Any

from ..pricing import ARM_MODEL, Usage, price
from .base import (
    MAX_TOKENS,
    ArmResult,
    refusal_guard,
    stream_answer,
    truncation_note,
)

ARM = "agentic"
MAX_ITERATIONS = 15
GREP_MAX_MATCHES = 40
READ_MAX_LINES = 200

# The loop re-sends the whole conversation on every iteration, so without a cache
# breakpoint it pays full input price for the same tool output over and over —
# input billed grows quadratically in iterations. Caching the conversation prefix
# is the standard optimization for an agent loop, and leaving it out would make
# this arm a strawman on cost in the same way an undertuned arm 4 would be a
# strawman on accuracy.
#
# Breakpoints go on tool_result blocks, which this module constructs itself as
# plain dicts. The assistant turns are passed back exactly as the API returned
# them — thinking blocks in particular must be echoed unmodified — so they are
# never annotated.
#
# Two breakpoints, not one. One trailing breakpoint is enough in the normal case:
# a turn adds three or four blocks, and the lookback walks back twenty positions
# to find the previous turn's write. It stops being enough when the model issues a
# burst of parallel tool calls, since each one contributes a tool_use block and a
# tool_result block and a wide enough turn can push the previous write out of the
# window. The second breakpoint sits a turn further back as insurance, and costs
# nothing extra to declare because that position is already cached.
CACHE_BREAKPOINTS = 2
# A single question's loop finishes in well under a minute and nothing is shared
# across questions — the system prompt alone is below the minimum cacheable
# length — so the cheaper 5-minute write is the right one here.
CACHE_TTL = "5m"

SYSTEM = (
    "You answer questions about a document you cannot see in full. You have two "
    "tools: `grep` to find lines matching a regular expression, and `read_lines` "
    "to read a range of lines.\n\n"
    "Work by searching for terms the answer would use, reading around the hits, "
    "and following references onward. Search more than once with different "
    "wording before concluding something is not there — a term may appear under "
    "a synonym or a defined term.\n\n"
    "When you have the answer, state it and cite the line numbers it rests on. "
    "If the document does not contain the answer, say so plainly and say what "
    "you searched for — do not infer a plausible answer from adjacent text. If "
    "the question asks for a count, enumerate what you counted with line "
    "references."
)

TOOLS: list[dict[str, Any]] = [
    {
        "name": "grep",
        "description": (
            "Search the document for lines matching a Python regular expression, "
            "case-insensitive. Returns matching lines with their line numbers. "
            "Use this to locate where a topic is discussed. Returns at most "
            f"{GREP_MAX_MATCHES} matches — narrow the pattern if you hit the cap."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Python regular expression, matched case-insensitively.",
                }
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "read_lines",
        "description": (
            "Read a range of lines from the document, inclusive, 1-indexed. Use "
            "this after grep to read the surrounding context of a match. Reads at "
            f"most {READ_MAX_LINES} lines per call."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start": {"type": "integer", "description": "First line to read (1-indexed)."},
                "end": {"type": "integer", "description": "Last line to read, inclusive."},
            },
            "required": ["start", "end"],
        },
    },
]


def _grep(lines: list[str], pattern: str) -> str:
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"Invalid regular expression: {exc}"
    hits = [(i + 1, line) for i, line in enumerate(lines) if rx.search(line)]
    if not hits:
        return "No matches."
    capped = hits[:GREP_MAX_MATCHES]
    body = "\n".join(f"{n}: {line.strip()}" for n, line in capped)
    if len(hits) > GREP_MAX_MATCHES:
        body += f"\n\n({len(hits)} matches total; showing the first {GREP_MAX_MATCHES}.)"
    return body


def _read_lines(lines: list[str], start: int, end: int) -> str:
    start = max(1, int(start))
    end = min(len(lines), int(end))
    if start > end:
        return f"Empty range: the document has {len(lines)} lines."
    end = min(end, start + READ_MAX_LINES - 1)
    return "\n".join(f"{n}: {lines[n - 1]}" for n in range(start, end + 1))


def _apply_cache_breakpoints(messages: list[dict[str, Any]]) -> None:
    """Move the cache breakpoints to the most recent tool-result turns, in place.

    Re-applied every iteration: stale breakpoints are cleared first, because the
    request may carry at most four and an append-only scheme would run out. Only
    the *last* block of a chosen turn is annotated, so the breakpoint sits at the
    end of that turn's contribution to the prefix.
    """
    tool_result_turns = [
        message
        for message in messages
        if message["role"] == "user"
        and isinstance(message["content"], list)
        and all(
            isinstance(block, dict) and block.get("type") == "tool_result"
            for block in message["content"]
        )
    ]

    for message in tool_result_turns:
        for block in message["content"]:
            block.pop("cache_control", None)

    for message in tool_result_turns[-CACHE_BREAKPOINTS:]:
        message["content"][-1]["cache_control"] = {
            "type": "ephemeral",
            "ttl": CACHE_TTL,
        }


def _dispatch(lines: list[str], name: str, args: dict) -> str:
    if name == "grep":
        return _grep(lines, str(args.get("pattern", "")))
    if name == "read_lines":
        return _read_lines(lines, args.get("start", 1), args.get("end", 1))
    return f"Unknown tool: {name}"


def run(*, doc_id: str, document: str, question_id: str, question: str) -> ArmResult:
    lines = document.split("\n")
    system = (
        f"{SYSTEM}\n\nThe document has {len(lines)} lines and is titled by its own "
        "opening lines; read them if you need orientation."
    )

    messages: list[dict[str, Any]] = [{"role": "user", "content": question}]
    t0 = time.perf_counter()
    total = Usage()
    deltas: list[tuple[int, str]] = []
    ttft_ms = 0
    tool_calls: list[dict[str, Any]] = []
    answer = ""

    for iteration in range(MAX_ITERATIONS):
        capture = stream_answer(
            system=system,
            messages=messages,
            tools=TOOLS,
            started_at=t0,
            max_tokens=MAX_TOKENS,
            cache_ttl=CACHE_TTL,
        )
        refusal_guard(capture)
        total = total + capture.usage
        if capture.deltas and not deltas:
            ttft_ms = capture.deltas[0][0]
        deltas.extend(capture.deltas)

        message = capture.raw
        uses = [b for b in message.content if getattr(b, "type", "") == "tool_use"]

        # A server-side pause is not a tool call; re-send to let it resume.
        if message.stop_reason == "pause_turn":
            messages.append({"role": "assistant", "content": message.content})
            continue

        if not uses:
            answer = capture.text
            break

        messages.append({"role": "assistant", "content": message.content})
        results = []
        for use in uses:
            output = _dispatch(lines, use.name, dict(use.input))
            tool_calls.append(
                {"iteration": iteration, "tool": use.name, "input": dict(use.input)}
            )
            results.append(
                {"type": "tool_result", "tool_use_id": use.id, "content": output}
            )
        # All results for one assistant turn go back in a single user message;
        # splitting them trains the model out of parallel tool use.
        messages.append({"role": "user", "content": results})
        _apply_cache_breakpoints(messages)
    else:
        answer = (
            capture.text
            or "(Reached the tool-iteration cap without producing a final answer.)"
        )

    latency_ms = int((time.perf_counter() - t0) * 1000)
    return ArmResult(
        arm=ARM,
        doc_id=doc_id,
        question_id=question_id,
        answer=answer,
        deltas=deltas,
        usage=total,
        cost=price(total, ARM_MODEL),
        latency_ms=latency_ms,
        ttft_ms=ttft_ms,
        notes={
            "tool_calls": tool_calls,
            "iterations": total.calls,
            "hit_iteration_cap": total.calls >= MAX_ITERATIONS,
            "retrieval": "model-driven grep and read over the raw document",
            "cache_ttl": CACHE_TTL,
            "cache_breakpoints": CACHE_BREAKPOINTS,
            # Zero here on a single-iteration question is expected — there was no
            # prior turn to read. Zero across a multi-iteration loop means the
            # conversation prefix is not being cached and this arm's cost is
            # inflated several-fold.
            "cache_read_tokens": total.cache_read_tokens,
            **truncation_note(capture),
        },
    )
