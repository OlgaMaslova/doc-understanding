"""Load the repo-root `.env` into the process environment.

`.env.example` tells you to copy it to `.env`, and both the README and the web
app's run panel assume that is enough. Nothing was actually reading it: the
pipeline only consulted `os.environ`, so a documented setup produced a confusing
"no credentials" failure — and the run panel would report itself ready and then
fail, because it detects the file's presence but cannot inject values the pipeline
never reads.

Deliberately hand-rolled rather than adding python-dotenv. The format this needs
to support is `KEY=value` with comments and optional quotes; a dependency for that
is not worth the install.

**Environment always wins.** A value already set in the environment is never
overwritten, so `ANTHROPIC_API_KEY=... python -m docrace.precompute` and CI
secrets behave as expected and a stale `.env` cannot silently shadow them.
"""

from __future__ import annotations

import os

from .paths import REPO_ROOT

ENV_FILE = REPO_ROOT / ".env"


def load_env(path=None) -> dict[str, str]:
    """Read `.env` and set any variable not already in the environment.

    Returns the names it set, so a caller can report what came from the file
    without ever handling the values.
    """
    target = path or ENV_FILE
    if not target.exists():
        return {}

    applied: dict[str, str] = {}
    for raw in target.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        # Strip one layer of matching quotes; leave inner content alone.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not key or not value:
            continue
        if key in os.environ:
            continue
        os.environ[key] = value
        applied[key] = value
    return applied
