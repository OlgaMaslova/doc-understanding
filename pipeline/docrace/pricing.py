"""Cost accounting. Rates live in data/pricing.json and nowhere else.

Every number the UI shows traces back to a Usage record produced by an arm and
the snapshot in that file, so a price change is one edit plus a re-run.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Any

from .env import load_env
from .paths import PRICING_FILE

DEFAULT_ARM_MODEL = "claude-opus-5"

# Fixed on purpose, not configurable alongside ARM_MODEL:
#
#   INDEX_MODEL — contextual prefixes and extractions are cached on disk keyed by
#   document only, so a model switch would silently reuse artifacts written by a
#   different model, or pay to regenerate them without saying why. And keeping the
#   index constant isolates the variable: a run compares *answering* models, not
#   answering-plus-indexing bundles.
#
#   JUDGE_MODEL (in grading.py) — the answer key is only comparable across arms and
#   models if the same judge graded everything. A cheaper judge for a cheaper arm
#   model would make the accuracy axis mean different things per column.
INDEX_MODEL = "claude-opus-5"


@lru_cache(maxsize=1)
def pricing() -> dict[str, Any]:
    return json.loads(PRICING_FILE.read_text())


def _resolve_arm_model() -> str:
    """The model the arms answer with, from `DOCRACE_MODEL`.

    An environment variable rather than a CLI flag because the model is baked into
    default arguments and module constants at import time — by the time argparse
    runs, every `def run(..., model=ARM_MODEL)` has already bound. The env var is
    read once, here, before anything imports it.

    Validated against the rate card, not just accepted: a run on a model this file
    cannot price would produce cells with silently wrong economics, which is worse
    than refusing to start.
    """
    load_env()  # so DOCRACE_MODEL in the repo .env works regardless of import order
    model = (os.environ.get("DOCRACE_MODEL") or "").strip() or DEFAULT_ARM_MODEL
    known = pricing()["models"]
    if model not in known:
        raise SystemExit(
            f"DOCRACE_MODEL={model!r} has no entry in {PRICING_FILE.name}. "
            f"Known models: {', '.join(known)}. Add a rate-card entry before running it."
        )
    return model


ARM_MODEL = _resolve_arm_model()


def snapshot_date() -> str:
    return pricing()["snapshot_date"]


def model_rates(model: str) -> dict[str, Any]:
    rates = pricing()["models"].get(model)
    if rates is None:
        raise KeyError(
            f"{model} has no entry in {PRICING_FILE.name}; add one before pricing its usage"
        )
    return rates


def model_snapshot_date(model: str) -> str:
    """When this model's rates were read.

    Per-model, because adding a provider means reading that provider's rate card
    on the day you add it — and bumping the file's single date would silently
    assert the other providers' rates were re-verified too. An entry without its
    own date belongs to the file-level snapshot.
    """
    return model_rates(model).get("rates_snapshot_date") or snapshot_date()


def provider_of(model: str) -> str:
    """Which API serves this model. Absent means Anthropic, the original provider."""
    return model_rates(model).get("provider", "anthropic")


def wire_model_id(model: str) -> str:
    """The id to send on the wire, which is not always the id we key on.

    Fireworks model ids are paths (`accounts/fireworks/models/...`) and would
    turn `results/<doc>.<model>.json` into a nested path, so the rate card keys
    on a short name and carries the wire id beside it.
    """
    return model_rates(model).get("wire_model_id", model)


def cache_style_of(model: str) -> str:
    """How this model's provider exposes prompt caching.

    Drives which cached-context arms exist for a run — see the `note_cache_styles`
    entry in the rate card, and `arms.arms_for`.
    """
    style = model_rates(model).get("cache", "explicit_ttl")
    if style not in ("explicit_ttl", "auto", "none"):
        raise SystemExit(
            f"{model} declares cache={style!r} in {PRICING_FILE.name}; expected "
            "'explicit_ttl', 'auto', or 'none'."
        )
    return style


@dataclass
class Usage:
    """Token counts for one or more Claude calls, plus Voyage token counts.

    Cache writes are split by TTL because they are priced differently (1.25x
    input at 5 minutes, 2x at an hour) while reads cost the same either way.
    `calls` keeps the call count visible for arms that loop — cost variance per
    query is part of what the demo is showing, not noise to average out.
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_5m_tokens: int = 0
    cache_write_1h_tokens: int = 0
    embed_tokens: int = 0
    rerank_tokens: int = 0
    calls: int = 0

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            **{
                f: getattr(self, f) + getattr(other, f)
                for f in (
                    "input_tokens",
                    "output_tokens",
                    "cache_read_tokens",
                    "cache_write_5m_tokens",
                    "cache_write_1h_tokens",
                    "embed_tokens",
                    "rerank_tokens",
                    "calls",
                )
            }
        )

    @property
    def cache_write_tokens(self) -> int:
        return self.cache_write_5m_tokens + self.cache_write_1h_tokens

    @classmethod
    def from_message_usage(cls, u: Any, *, ttl: str = "5m") -> "Usage":
        """Build from an Anthropic response `usage` object.

        `input_tokens` is the uncached remainder only — cache reads and writes
        are reported separately and priced differently, so all three are kept.
        Newer responses break writes down by TTL under `cache_creation`; when
        that is absent we attribute the write to the TTL the caller requested.
        """
        written = getattr(u, "cache_creation_input_tokens", 0) or 0
        breakdown = getattr(u, "cache_creation", None)
        five_m = getattr(breakdown, "ephemeral_5m_input_tokens", None)
        one_h = getattr(breakdown, "ephemeral_1h_input_tokens", None)
        if five_m is not None or one_h is not None:
            five_m, one_h = five_m or 0, one_h or 0
        else:
            five_m, one_h = (0, written) if ttl == "1h" else (written, 0)
        return cls(
            input_tokens=u.input_tokens or 0,
            output_tokens=u.output_tokens or 0,
            cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
            cache_write_5m_tokens=five_m,
            cache_write_1h_tokens=one_h,
            calls=1,
        )

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass
class Cost:
    """USD, broken out so the UI can explain where a number came from."""

    input: float = 0.0
    output: float = 0.0
    cache_read: float = 0.0
    cache_write: float = 0.0
    embed: float = 0.0
    rerank: float = 0.0

    def __add__(self, other: "Cost") -> "Cost":
        return Cost(
            **{
                f: getattr(self, f) + getattr(other, f)
                for f in ("input", "output", "cache_read", "cache_write", "embed", "rerank")
            }
        )

    @property
    def total(self) -> float:
        return (
            self.input
            + self.output
            + self.cache_read
            + self.cache_write
            + self.embed
            + self.rerank
        )

    def to_dict(self) -> dict[str, float]:
        d = {k: round(v, 8) for k, v in asdict(self).items()}
        d["total"] = round(self.total, 8)
        return d


def price(usage: Usage, model: str = ARM_MODEL) -> Cost:
    m = model_rates(model)
    v = pricing()["voyage"]

    def per_mtok(tokens: int, rate: float) -> float:
        return (tokens / 1_000_000) * rate

    def write_rate(tokens: int, field: str) -> float:
        """Price a cache write, refusing to invent a rate for a provider without one.

        An auto-caching provider bills the uncached remainder as ordinary input and
        charges no write premium, so its entry carries no write rates at all. Zero
        tokens is therefore free and correct. Non-zero tokens against a missing rate
        means an arm attributed a write to a provider that cannot report one — and
        defaulting that to $0 would print "warming this cache is free" as if it were
        measured. Fail instead.
        """
        if not tokens:
            return 0.0
        rate = m.get(field)
        if rate is None:
            raise KeyError(
                f"{model} recorded {tokens} {field.replace('_per_mtok', '')} tokens "
                f"but has no {field} in {PRICING_FILE.name} (cache="
                f"{m.get('cache', 'explicit_ttl')!r}). A provider that caches "
                "automatically has no write premium to quote, so this usage cannot "
                "be priced — the arm should be recording these as input tokens."
            )
        return per_mtok(tokens, rate)

    return Cost(
        input=per_mtok(usage.input_tokens, m["input_per_mtok"]),
        output=per_mtok(usage.output_tokens, m["output_per_mtok"]),
        cache_read=per_mtok(usage.cache_read_tokens, m["cache_read_per_mtok"]),
        cache_write=(
            write_rate(usage.cache_write_5m_tokens, "cache_write_5m_per_mtok")
            + write_rate(usage.cache_write_1h_tokens, "cache_write_1h_per_mtok")
        ),
        embed=per_mtok(usage.embed_tokens, v["embed_per_mtok"]),
        rerank=per_mtok(usage.rerank_tokens, v["rerank_per_mtok"]),
    )
