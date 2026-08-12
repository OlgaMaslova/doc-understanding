# results/

This directory holds the precomputed comparison data the site serves. It is **empty
in a fresh clone** — the JSON is generated, not committed (see `.gitignore`).

Nothing here calls an API at request time. The deployed site reads these files and
replays recorded answer streams, which is what makes it instant, deterministic, and
free to visit regardless of traffic.

**There is no synthetic mode.** Every number in these files is measured. A fixture
generator existed while the interface was being built and was removed: each file it
wrote carried a header claiming which model produced the answers and when they were
computed, both false, and its hardcoded document token counts eventually drifted
30–50% from the real ones — surfacing in the document picker, outside the scope of
any warning. If a number is on the page, an API call produced it.

## Produce it

```sh
cd pipeline
cp ../.env.example ../.env                          # then fill in both keys
.venv/bin/python -m docrace.documents --meta-only   # free; token counts
.venv/bin/python -m docrace.estimate                # what a run would cost
```

Then run as much or as little as you want. The cheapest run that proves anything:

```sh
.venv/bin/python -m docrace.precompute --doc arxiv-paper --limit 2 \
    --arm naive_rag --arm cached_context_1h          # about $0.42
```

Two questions is the minimum worth running — the first warms the cache, the second
reads it, and whether that read happens is the assumption the whole comparison rests
on. The full matrix is about $81.

Resumable: indexes, contextual prefixes, and extractions cache under
`pipeline/.index-cache/`, and cells already present here are skipped unless
`--force` is passed. An interrupted run costs nothing to resume.

### From the browser

In a local clone you can also run it from the UI, with no flag to set:

```sh
cd web && npm run dev
```

Choose "run the evals" at the fork, pick a document and the approaches, and the panel
prices the scope, asks for confirmation, and streams progress per cell — writing here
as it goes. A run asks every question in the document's set. It refuses scopes over
$25 (`DOCRACE_MAX_RUN_USD` to change that) and prints the equivalent CLI command
instead. See the README for the gates involved.

## Partial runs are expected, and labelled

A scoped run leaves an incomplete matrix. Each document records `provenance_state`
(`partial` or `measured`) along with its cell count, and the site says so — on the
document picker, under the title, and in a banner. The figures are real either way;
what a partial run cannot support is an aggregate. A heatmap built from two cells is
a spot check, and the page calls it one.

## What lands here

| File | |
|---|---|
`manifest.json` | Documents with completeness state, arms, question types, grade vocabulary, model, pricing snapshot date |
`arxiv-paper.json` | Up to 105 cells (7 arms × 15 questions) plus per-arm economics |
`edgar-contract.json` | same |
`form-10k.json` | same |

Each cell holds the answer text, the delta stream with millisecond offsets, token
usage, a cost breakdown, latency, arm-specific notes, and a grade with its
rationale.
