"""Shared provider clients and token counting.

Anthropic is the original and still the only provider for indexing and grading
(see pricing.py and grading.py for why those stay fixed). The arms may answer
with a model from another provider, so the client used to answer is resolved
from the rate card's `provider` field rather than assumed.
"""

from __future__ import annotations

import functools
import os

import anthropic

from .env import load_env
from .pricing import INDEX_MODEL, provider_of

# Import-time so every entry point benefits — the CLI, the module invoked by the
# web app's run panel, and the scripts. Values already in the environment win.
load_env()

FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"


class MissingCredentials(RuntimeError):
    pass


@functools.lru_cache(maxsize=1)
def anthropic_client() -> anthropic.Anthropic:
    # A bare constructor also resolves an `ant auth login` profile, so only
    # complain when nothing at all is available.
    if not (
        os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or (os.path.expanduser("~/.config/anthropic/credentials") and os.path.isdir(
            os.path.expanduser("~/.config/anthropic")
        ))
    ):
        raise MissingCredentials(
            "No Anthropic credentials found. Either copy .env.example to .env at "
            "the repo root and fill it in, export ANTHROPIC_API_KEY, or run "
            "`ant auth login`."
        )
    return anthropic.Anthropic()


@functools.lru_cache(maxsize=1)
def fireworks_client():
    """OpenAI-compatible client for Fireworks' serverless endpoints.

    Imported lazily so a clone that only ever runs Claude models does not need the
    `openai` package installed to import this module.
    """
    try:
        import openai
    except ModuleNotFoundError as exc:  # pragma: no cover — install-time condition
        raise MissingCredentials(
            "The `openai` package is required to answer with a Fireworks model. "
            "Re-install the pipeline: .venv/bin/pip install -e ."
        ) from exc

    key = os.environ.get("FIREWORKS_API_KEY")
    if not key:
        raise MissingCredentials(
            "FIREWORKS_API_KEY is not set, and the selected DOCRACE_MODEL is served "
            "by Fireworks. Add it to .env at the repo root or export it."
        )
    return openai.OpenAI(base_url=FIREWORKS_BASE_URL, api_key=key)


def client_for(model: str):
    """The client that can answer with `model`, per its rate-card provider."""
    provider = provider_of(model)
    if provider == "anthropic":
        return anthropic_client()
    if provider == "fireworks":
        return fireworks_client()
    raise SystemExit(
        f"{model} declares provider={provider!r}, which has no client. Known "
        "providers: anthropic, fireworks."
    )


def count_tokens(text: str, model: str = INDEX_MODEL) -> int:
    """Exact token count for `text` on `model`.

    Token counts are model-specific; never estimate with a third-party
    tokenizer, and never compare a count taken on one model to another.

    Defaults to INDEX_MODEL rather than the answering model on purpose. The only
    caller is the document-fetch pass, whose counts describe a *document* — they
    drive the picker and the estimator, and are compared across result sets
    measured with different answering models. Pinning them to one tokenizer keeps
    that comparison meaningful; it also means the count is that tokenizer's, not a
    universal truth, which is why the UI attributes it.
    """
    resp = anthropic_client().messages.count_tokens(
        model=model,
        messages=[{"role": "user", "content": text}],
    )
    return resp.input_tokens


def voyage_api_key() -> str:
    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        raise MissingCredentials(
            "VOYAGE_API_KEY is not set; arms 3 and 4 need Voyage embeddings and "
            "reranking. Add it to .env at the repo root or export it."
        )
    return key
