"""Answering with an OpenAI-compatible provider, in Anthropic's shapes.

Everything upstream of this module speaks Anthropic: system prompts are lists of
content blocks, tools carry an `input_schema`, tool results come back as
`tool_result` blocks, and `stream_answer` returns a `StreamCapture` whose `raw`
has `.content` and `.stop_reason`. Rewriting the arms to be provider-neutral
would have meant touching all six; translating at the wire boundary instead
means only this file knows another provider exists.

So the direction of travel is deliberate: Anthropic's shapes are the internal
representation, and this module converts to the OpenAI chat-completions wire
format on the way out and back to Anthropic-shaped objects on the way in. The
adapter classes at the top exist for the return trip — arm 5 appends the
assistant turn it receives straight back onto its message list, so what we hand
it has to survive being fed in again.

Two things that are easy to get wrong and are the reason this file is not a
thin `dict` remap:

**Cached tokens are counted differently.** Anthropic reports `input_tokens` as
the *uncached remainder* and cache reads separately. OpenAI-compatible
`prompt_tokens` is the *total*, with the cached portion broken out underneath
it. Adding both into `Usage` unchanged would bill the cached span twice — once
at input rate, once at the cache-read rate — so the cached count is subtracted
out (see `_usage_from`).

**Caching cannot be switched off.** On Fireworks it is on for every request with
no opt-out, which would quietly turn arm 1 into a second cached arm as soon as
its questions run back to back over one document. `cache_scope` is the answer:
every request carries an isolation key, so a request with a fresh key is
guaranteed to miss and one reusing a scope is guaranteed to find its own entry.
That makes "uncached" a measurement again rather than an assumption, and it is
the provider-side analogue of the marker line in `cached_context`.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from ..client import client_for
from ..pricing import Usage, wire_model_id

# Fireworks documents this as forcing cache separation for byte-identical
# prompts. We use it in both directions: a unique value per request to guarantee
# a miss, or a caller-supplied scope to keep one arm's entries to itself.
ISOLATION_HEADER = "x-prompt-cache-isolation-key"


# ---------------------------------------------------------------------------
# Anthropic-shaped response objects
#
# Only the fields the arms actually read. `type` is a plain attribute rather
# than a class check because the arms discriminate with
# `getattr(block, "type", "")`.
# ---------------------------------------------------------------------------


@dataclass
class TextBlock:
    text: str
    type: str = "text"


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict[str, Any]
    type: str = "tool_use"


@dataclass
class AdaptedMessage:
    """Stands in for an Anthropic `Message` on the arms' side of the boundary."""

    content: list[Any] = field(default_factory=list)
    stop_reason: str | None = None
    # Present so `refusal_guard`'s `getattr(raw, "stop_details", None)` finds
    # something falsy rather than raising.
    stop_details: Any = None


# ---------------------------------------------------------------------------
# Request translation: Anthropic shapes -> OpenAI chat completions
# ---------------------------------------------------------------------------


def _system_text(system: Any) -> str:
    """Flatten an Anthropic system prompt into one system message.

    A block list is how the Anthropic path places cache breakpoints; there is no
    equivalent to place here, so the `cache_control` keys are dropped and the text
    is joined. Nothing is lost that the provider could have acted on — caching is
    automatic and prefix-based either way.
    """
    if isinstance(system, str):
        return system
    parts = [b["text"] for b in system if b.get("type") == "text"]
    return "\n\n".join(parts)


def _tool_arguments(raw: str | None, name: str) -> dict[str, Any]:
    """Parse a tool call's arguments, failing loudly on malformed JSON.

    Weaker tool-calling is a real finding for an open model, and it has to be
    distinguishable from an arm that answered badly. Raising here surfaces as an
    error cell that a re-run retries, rather than a silently empty tool input that
    would be graded as a wrong answer.
    """
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Model emitted unparseable arguments for tool {name!r}: {raw!r} ({exc}). "
            "This is a tool-calling failure, not an arm failure."
        ) from None
    if not isinstance(parsed, dict):
        raise RuntimeError(
            f"Model emitted non-object arguments for tool {name!r}: {parsed!r}."
        )
    return parsed


def _assistant_message(blocks: list[Any]) -> dict[str, Any]:
    """An assistant turn being replayed: our own adapter blocks, going back out."""
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for block in blocks:
        kind = getattr(block, "type", None) or (
            block.get("type") if isinstance(block, dict) else None
        )
        if kind == "text":
            text_parts.append(
                getattr(block, "text", None) if not isinstance(block, dict) else block["text"]
            )
        elif kind == "tool_use":
            use = block if not isinstance(block, dict) else None
            tool_calls.append(
                {
                    "id": use.id if use else block["id"],
                    "type": "function",
                    "function": {
                        "name": use.name if use else block["name"],
                        "arguments": json.dumps(use.input if use else block["input"]),
                    },
                }
            )
    message: dict[str, Any] = {"role": "assistant"}
    # `content` must be present even when empty, and must be null rather than ""
    # when the turn was tool calls only.
    message["content"] = "\n".join(p for p in text_parts if p) or None
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def _user_messages(content: Any) -> list[dict[str, Any]]:
    """A user turn, which may be text or a batch of tool results.

    Tool results are the shape change that matters: Anthropic carries every result
    for a turn as blocks inside one user message, while OpenAI wants one `tool`
    message per call. One in, many out.
    """
    if isinstance(content, str):
        return [{"role": "user", "content": content}]

    out: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for block in content:
        kind = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
        if kind == "text":
            text_parts.append(block["text"] if isinstance(block, dict) else block.text)
        elif kind == "tool_result":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": block["tool_use_id"],
                    "content": block["content"],
                }
            )
    if text_parts:
        # Text blocks precede any tool results in the turns the arms build, and
        # in practice a turn is one or the other, never both.
        out.insert(0, {"role": "user", "content": "\n\n".join(text_parts)})
    return out


def _to_openai_messages(system: Any, messages: list[dict]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    system_text = _system_text(system)
    if system_text:
        out.append({"role": "system", "content": system_text})
    for message in messages:
        if message["role"] == "assistant":
            content = message["content"]
            if isinstance(content, str):
                out.append({"role": "assistant", "content": content})
            else:
                out.append(_assistant_message(content))
        else:
            out.extend(_user_messages(message["content"]))
    return out


def _to_openai_tools(tools: list[dict]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["input_schema"],
            },
        }
        for tool in tools
    ]


STOP_REASONS = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "content_filter": "refusal",
}


def _usage_from(raw: Any) -> Usage:
    """Map an OpenAI-compatible `usage` object onto our `Usage`.

    `prompt_tokens` includes the cached prefix, so the cached count is subtracted
    to leave the uncached remainder — the same thing Anthropic's `input_tokens`
    already means. Cache writes stay at zero: an auto-caching provider bills the
    uncached remainder at the normal input rate and charges no write premium, so
    there is no third number to record (and `price` refuses to invent one).
    """
    if raw is None:
        return Usage(calls=1)
    prompt = getattr(raw, "prompt_tokens", 0) or 0
    details = getattr(raw, "prompt_tokens_details", None)
    cached = (getattr(details, "cached_tokens", 0) or 0) if details else 0
    # Clamp: a provider reporting more cached than prompt tokens would otherwise
    # produce a negative bill.
    cached = min(cached, prompt)
    return Usage(
        input_tokens=prompt - cached,
        output_tokens=getattr(raw, "completion_tokens", 0) or 0,
        cache_read_tokens=cached,
        calls=1,
    )


def stream(
    *,
    system: Any,
    messages: list[dict],
    tools: list[dict] | None,
    model: str,
    max_tokens: int,
    started_at: float | None,
    extra: dict | None,
    cache_scope: str | None,
) -> tuple[str, list[tuple[int, str]], Usage, int, int, AdaptedMessage]:
    """Stream one completion, returning what `StreamCapture` needs.

    Signature mirrors `base.stream_answer`'s keyword arguments so the dispatch
    there stays a straight hand-off.
    """
    client = client_for(model)
    t0 = started_at if started_at is not None else time.perf_counter()
    deltas: list[tuple[int, str]] = []
    ttft_ms = 0

    kwargs: dict[str, Any] = {
        "model": wire_model_id(model),
        "max_tokens": max_tokens,
        "messages": _to_openai_messages(system, messages),
        "stream": True,
        # Without this the final chunk carries no usage and every cell would be
        # priced at zero.
        "stream_options": {"include_usage": True},
    }
    if tools:
        kwargs["tools"] = _to_openai_tools(tools)
    if extra:
        kwargs.update(extra)

    # A fresh key per request is the uncached path; a caller-supplied scope is how
    # an arm keeps its own cache entries and pays its own warm.
    kwargs["extra_headers"] = {ISOLATION_HEADER: cache_scope or f"fresh-{uuid.uuid4()}"}

    text_parts: list[str] = []
    # Tool calls arrive fragmented across chunks — name on one, arguments a few
    # characters at a time on later ones — so they are accumulated by index.
    calls: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None
    usage_raw: Any = None

    for chunk in client.chat.completions.create(**kwargs):
        if getattr(chunk, "usage", None):
            usage_raw = chunk.usage
        if not chunk.choices:
            # The usage-only trailer has no choices.
            continue
        choice = chunk.choices[0]
        if choice.finish_reason:
            finish_reason = choice.finish_reason
        delta = choice.delta
        if delta is None:
            continue

        piece = getattr(delta, "content", None)
        if piece:
            elapsed = int((time.perf_counter() - t0) * 1000)
            if not deltas:
                ttft_ms = elapsed
            deltas.append((elapsed, piece))
            text_parts.append(piece)

        for call in getattr(delta, "tool_calls", None) or []:
            slot = calls.setdefault(call.index, {"id": None, "name": None, "args": ""})
            if call.id:
                slot["id"] = call.id
            fn = getattr(call, "function", None)
            if fn is not None:
                if getattr(fn, "name", None):
                    slot["name"] = fn.name
                if getattr(fn, "arguments", None):
                    slot["args"] += fn.arguments

    latency_ms = int((time.perf_counter() - t0) * 1000)
    text = "".join(text_parts)

    content: list[Any] = []
    if text:
        content.append(TextBlock(text=text))
    for index in sorted(calls):
        slot = calls[index]
        name = slot["name"]
        if not name:
            continue
        content.append(
            ToolUseBlock(
                id=slot["id"] or f"call-{index}-{uuid.uuid4().hex[:8]}",
                name=name,
                input=_tool_arguments(slot["args"], name),
            )
        )

    message = AdaptedMessage(
        content=content,
        stop_reason=STOP_REASONS.get(finish_reason or "", finish_reason),
    )
    return text, deltas, _usage_from(usage_raw), latency_ms, ttft_ms, message
