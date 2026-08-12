"""Shared Anthropic client and token counting."""

from __future__ import annotations

import functools
import os

import anthropic

from .env import load_env
from .pricing import ARM_MODEL

# Import-time so every entry point benefits — the CLI, the module invoked by the
# web app's run panel, and the scripts. Values already in the environment win.
load_env()


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


def count_tokens(text: str, model: str = ARM_MODEL) -> int:
    """Exact token count for `text` on `model`.

    Token counts are model-specific; never estimate with a third-party
    tokenizer, and never compare a count taken on one model to another.
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
