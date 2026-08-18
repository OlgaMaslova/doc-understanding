"""One structured-JSON call, on whichever provider serves the model.

The indexing passes — contextual prefixes and schema extraction — both need the
same thing: send a system prompt and one user turn, get back JSON matching a
schema, and record what it cost. Both used to call the Anthropic SDK directly,
which was fine while the index model was pinned to Claude. It is a choice now
(see `pricing.INDEX_MODEL`), so indexing has to reach a Fireworks model too.

This is the indexing-side counterpart to `arms.openai_compat`, and it delegates
the wire translation to that module rather than repeating it. What it adds is the
part the arms never needed: structured output, and a non-streaming call.

Caching is the one place the two providers genuinely differ rather than just
spelling things differently. A document sent as a cached prefix across 30-odd
batches is the difference between $3 and $30 on a large document, and:

  explicit_ttl — the caller places a breakpoint and names a lifetime, so the
    prefix must carry `cache_control` and the write is billed once, up front.
  auto — the provider caches every prefix on its own. There is no breakpoint to
    place and no write premium; what the caller controls instead is *isolation*,
    so batches of one indexing pass share a scope and hit each other's entries.

`cache_scope` covers both: it names the shared prefix, and each provider does
what it can with that.
"""

from __future__ import annotations

import json
from typing import Any

from .client import anthropic_client, client_for
from .pricing import Usage, provider_of, wire_model_id


class StructuredOutputUnsupported(RuntimeError):
    """The provider would not accept a schema, so the JSON cannot be trusted."""


def _check_complete(stop_reason: str | None, label: str, max_tokens: int) -> None:
    """A truncated structured output is invalid JSON; fail with the cause.

    Worth failing loudly rather than returning a partial record: the index is
    built once and read by every query, so a silently short extraction would look
    like the arm answering badly for the rest of the run.
    """
    if stop_reason in ("end_turn", "stop", None):
        return
    hint = (
        f" The {max_tokens}-token budget is the likely cause; the schema is "
        "eliciting more output than it allows."
        if stop_reason in ("max_tokens", "length")
        else ""
    )
    raise RuntimeError(
        f"{label} stopped with {stop_reason!r} instead of completing; the "
        f"structured output is unusable.{hint}"
    )


def _anthropic(
    *,
    system: Any,
    messages: list[dict],
    schema: dict[str, Any],
    model: str,
    max_tokens: int,
    label: str,
) -> tuple[dict[str, Any], Usage]:
    # Streamed because the extraction windows run long enough to hit the
    # non-streaming timeout, and `get_final_message` gives back the same object.
    with anthropic_client().messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=messages,
        output_config={"format": {"type": "json_schema", "schema": schema}},
    ) as stream:
        message = stream.get_final_message()
    _check_complete(message.stop_reason, label, max_tokens)
    text = next(b.text for b in message.content if b.type == "text")
    # 1h because the only cached prefix indexing sends is the document, and it is
    # read back across every batch of a pass that can run for minutes.
    return json.loads(text), Usage.from_message_usage(message.usage, ttl="1h")


def _openai_compat(
    *,
    system: Any,
    messages: list[dict],
    schema: dict[str, Any],
    model: str,
    max_tokens: int,
    label: str,
    cache_scope: str | None,
) -> tuple[dict[str, Any], Usage]:
    from .arms import openai_compat as compat

    client = client_for(model)
    kwargs: dict[str, Any] = {
        "model": wire_model_id(model),
        "max_tokens": max_tokens,
        "messages": compat._to_openai_messages(system, messages),
    }
    if cache_scope:
        # Unlike an arm, indexing *wants* the hits: every batch re-sends the same
        # document prefix, and sharing one scope is what makes the second batch
        # onwards cheap. Omitting the header would leave each batch to the
        # provider's default scoping rather than guaranteeing they share one.
        kwargs["extra_headers"] = {compat.ISOLATION_HEADER: cache_scope}

    # The OpenAI-standard spelling first, then the one Fireworks documented
    # before it adopted that spelling. Trying in this order means a provider
    # supporting both gets strict validation, and one supporting only the older
    # form still gets a schema rather than free-form JSON.
    attempts = [
        {
            "type": "json_schema",
            "json_schema": {"name": "index_record", "schema": schema, "strict": True},
        },
        {"type": "json_object", "schema": schema},
    ]

    last_error: Exception | None = None
    for response_format in attempts:
        try:
            completion = client.chat.completions.create(
                **kwargs, response_format=response_format
            )
            break
        except Exception as exc:  # narrowed below; openai's error types vary by version
            if type(exc).__name__ not in ("BadRequestError", "UnprocessableEntityError"):
                raise
            last_error = exc
    else:
        raise StructuredOutputUnsupported(
            f"{model} rejected every structured-output format this client knows "
            f"({label}). Indexing needs a schema-constrained response — free-form "
            f"JSON would parse sometimes and corrupt the index the rest of the "
            f"time. Last error: {last_error}"
        ) from last_error

    choice = completion.choices[0]
    _check_complete(
        compat.STOP_REASONS.get(choice.finish_reason or "", choice.finish_reason),
        label,
        max_tokens,
    )
    content = choice.message.content or ""
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"{label} returned unparseable JSON despite a schema being requested "
            f"({exc}). First 200 characters: {content[:200]!r}"
        ) from None
    return parsed, compat._usage_from(getattr(completion, "usage", None))


def structured_json(
    *,
    system: Any,
    messages: list[dict],
    schema: dict[str, Any],
    model: str,
    max_tokens: int,
    label: str,
    cache_scope: str | None = None,
) -> tuple[dict[str, Any], Usage]:
    """Return the parsed JSON and the usage that produced it.

    `system` and `messages` are in Anthropic's shapes — a block list for `system`
    so the caller can mark a cached prefix — because that is the internal
    representation everywhere else in the pipeline. `label` names the call in an
    error, and is the difference between "extraction window 3/8 truncated" and a
    JSONDecodeError with no provenance.
    """
    if provider_of(model) == "anthropic":
        return _anthropic(
            system=system,
            messages=messages,
            schema=schema,
            model=model,
            max_tokens=max_tokens,
            label=label,
        )
    return _openai_compat(
        system=system,
        messages=messages,
        schema=schema,
        model=model,
        max_tokens=max_tokens,
        label=label,
        cache_scope=cache_scope,
    )
