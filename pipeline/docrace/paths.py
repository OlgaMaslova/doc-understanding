"""Repo-relative paths. Everything else imports locations from here."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA = REPO_ROOT / "data"
DOCS = DATA / "docs"
SCHEMAS = DATA / "schemas"
PRICING_FILE = DATA / "pricing.json"
QUESTIONS_FILE = DATA / "questions.yaml"
RESULTS = REPO_ROOT / "results"
INDEX_CACHE = REPO_ROOT / "pipeline" / ".index-cache"
