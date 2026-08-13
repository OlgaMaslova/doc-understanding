#!/bin/bash
# Build a throwaway stand-in for the docrace repo: a bare "origin" plus a clone with
# main and static-pages diverged the way the real ones are. Tests run against this so
# a push can never reach GitHub.
#
# Usage: make-fixture.sh <dest-dir> [scenario]
#   scenario=publish  (default) main has a new result set, an extended one, and a
#                     removed one that static-pages still carries
#   scenario=nothing  the two branches already agree
set -euo pipefail

SCENARIO="${2:-publish}"
rm -rf "$1"
mkdir -p "$1"
# Absolute, because the clone's `origin` is this path and the script cds away.
DEST="$(cd "$1" && pwd)"
ORIGIN="$DEST/origin.git"
REPO="$DEST/repo"

git init -q --bare "$ORIGIN"
git init -q -b main "$REPO"
cd "$REPO"
git config user.email fixture@example.com
git config user.name Fixture
git remote add origin "$ORIGIN"

mkdir -p results data/docs web/app .claude

manifest() {
  # $@ = "doc:model:cells:expected:date" triples
  printf '{\n  "docs": [\n'
  local first=1
  for spec in "$@"; do
    IFS=: read -r doc model cells expected date <<<"$spec"
    [ $first -eq 0 ] && printf ',\n'
    first=0
    printf '    {"doc_id": "%s", "model": "%s", "file": "%s.%s.json", "cells": %s, "cells_expected": %s, "computed_at": "%s", "provenance_state": "%s"}' \
      "$doc" "$model" "$doc" "$model" "$cells" "$expected" "$date" \
      "$([ "$cells" = "$expected" ] && echo measured || echo partial)"
  done
  printf '\n  ],\n  "model": "claude-sonnet-5",\n  "pricing_snapshot": "2026-08-01"\n}\n'
}

result_file() { printf '{"doc_id": "%s", "model": "%s", "cells": {"full_context::q1": {"answer": "x"}}}\n' "$1" "$2"; }

# --- shared history -------------------------------------------------------------
manifest "arxiv-paper:claude-sonnet-5:105:105:2026-08-12" \
         "arxiv-paper:claude-haiku-4-5:12:105:2026-08-10" > results/manifest.json
result_file arxiv-paper claude-sonnet-5 > results/arxiv-paper.claude-sonnet-5.json
result_file arxiv-paper claude-haiku-4-5 > results/arxiv-paper.claude-haiku-4-5.json
printf '{"doc_id": "arxiv-paper", "domain": "scientific", "tokens": 25061}\n' > data/docs/arxiv-paper.json
printf '{"doc_id": "edgar-contract", "domain": "legal", "tokens": 53210}\n' > data/docs/edgar-contract.json
echo "# Docrace" > README.md
echo "export default function Page() { return <RunPanel /> }" > web/app/page.tsx
git add -A && git commit -qm "Shared history: arxiv measured"

# --- static-pages diverges (code differs, deliberately) -------------------------
git checkout -qb static-pages
echo "# Docrace — static build" > README.md
echo "export default function Page() { return <ComparisonView /> }" > web/app/page.tsx
printf 'name: Deploy\non:\n  push:\n    branches: [static-pages]\n' > .github-workflow-placeholder
git add -A && git commit -qm "Static build: no run flow"
git checkout -q main

if [ "$SCENARIO" = publish ]; then
  # A new model measured, an existing set extended, an old set superseded.
  manifest "arxiv-paper:claude-sonnet-5:105:105:2026-08-12" \
           "edgar-contract:claude-opus-5:105:105:2026-08-14" \
           "form-10k:claude-sonnet-5:30:105:2026-08-14" > results/manifest.json
  result_file edgar-contract claude-opus-5 > results/edgar-contract.claude-opus-5.json
  result_file form-10k claude-sonnet-5 > results/form-10k.claude-sonnet-5.json
  git rm -q results/arxiv-paper.claude-haiku-4-5.json
  printf '{"doc_id": "form-10k", "domain": "financial", "tokens": 223104}\n' > data/docs/form-10k.json
  git add -A && git commit -qm "Measure edgar-contract with claude-opus-5, start form-10k"
fi

git push -q origin main static-pages
git branch -q --set-upstream-to=origin/main main
git checkout -q static-pages && git branch -q --set-upstream-to=origin/static-pages static-pages
git checkout -q main

echo "fixture ready: $REPO (origin: $ORIGIN, scenario: $SCENARIO)"
