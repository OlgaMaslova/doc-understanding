# results/

This directory holds the precomputed race data the site serves. It is **empty in
a fresh clone** — the JSON is generated, not committed (see `.gitignore`).

Nothing here calls an API at request time. The deployed site reads these files and
replays recorded answer streams, which is what makes it instant, deterministic,
and free to visit regardless of traffic.

## Populate it

Two ways, and they write the same file shapes to the same paths, so the web app
cannot tell them apart except by the `fixture` flag each file carries.

### Fixtures — free, instant, synthetic

```sh
cd pipeline && .venv/bin/python scripts/make_fixtures.py
```

Generates plausible numbers with a fixed seed so the interface can be built and
reviewed without spending anything. The answers are invented. The **questions and
answer key are real** — loaded from `data/questions.yaml` — so the reference-answer
panel is worth reviewing even here.

Every fixture file is stamped `"fixture": true`, each document carries
`license: "fixture"`, each cell carries `notes.fixture: true`, and the site shows a
red banner. Synthetic numbers reaching a reader as though they were measurements is
the worst outcome this project could produce, so the provenance is deliberately
hard to lose.

### A real run — costs money, takes hours

```sh
cd pipeline
cp ../.env.example ../.env   # then fill in both keys
.venv/bin/python -m docrace.estimate        # what it will cost, with assumptions
.venv/bin/python -m docrace.precompute --doc arxiv-paper --limit 1   # smoke test
.venv/bin/python -m docrace.precompute      # the whole matrix
```

Every arm actually answers every question against `claude-opus-5`, a judge grades
each answer against the committed ground truth, and the streamed deltas are
recorded with their arrival times so replay reproduces the real race pacing. Files
are stamped `"fixture": false`.

Resumable: indexes, contextual prefixes, and extractions are cached under
`pipeline/.index-cache/`, and cells already present here are skipped unless
`--force` is passed. An interrupted run costs nothing to resume.

## What lands here

| File | |
|---|---|
`manifest.json` | Documents, arms, question types, grade vocabulary, model, pricing snapshot date, fixture flag |
`arxiv-paper.json` | 105 cells (7 arms × 15 questions) plus per-arm economics |
`edgar-contract.json` | same |
`form-10k.json` | same |

Each cell holds the answer text, the delta stream with millisecond offsets, token
usage, a cost breakdown, latency, arm-specific notes, and a grade with its
rationale.
