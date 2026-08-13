# results/

This directory holds the precomputed comparison data the site serves. The
committed files are real measurements — currently the arXiv paper's full matrix
(7 arms × 15 questions), answered with `claude-sonnet-5`. The other documents'
files appear when someone runs them.

One file holds one model's measurements of one document, and the model is in the
filename: `<doc>.<model>.json`. Measuring a document with a second model adds a
sibling file rather than touching the first, and the site offers the choice
wherever a document has more than one. (Files from before this layout — bare
`<doc>.json` — are renamed automatically the next time the pipeline runs.)

Nothing here calls an API at request time — on this branch there is no request time
at all. `next build` reads these files, prerenders the charts from them, and writes
the answers into static replay bundles under `web/public/replay/` (these files minus
the delta streams), which is what makes the site instant, deterministic, and free to
visit regardless of traffic.

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
`--force` is passed — except cells that recorded an error, which are retried
by default. An interrupted run costs nothing to resume.

### From the browser — on `main`, not here

`main` can drive a run from the UI: pick a document and the approaches, and the panel
prices the scope, asks for confirmation, and streams progress per cell — writing here
as it goes. This branch is the static deployment and has no such flow, because a
static host has no Python to shell out to. The terminal is the only path here, and it
is the one with no ceiling.

## Partial runs are expected, and labelled

A scoped run leaves an incomplete matrix. Each document records `provenance_state`
(`partial` or `measured`) along with its cell count, and the site says so — on the
document picker, under the title, and in a banner. The figures are real either way;
what a partial run cannot support is an aggregate. A heatmap built from two cells is
a spot check, and the page calls it one.

## What lands here

| File | |
|---|---|
`manifest.json` | One entry per (document, model) result set with completeness state and filename, plus arms, question types, grade vocabulary, pricing snapshot date |
`arxiv-paper.<model>.json` | Up to 105 cells (7 arms × 15 questions) plus per-arm economics, for one answering model |
`edgar-contract.<model>.json` | same |
`form-10k.<model>.json` | same |

Each cell holds the answer text, the delta stream with millisecond offsets, token
usage, a cost breakdown, latency, arm-specific notes, and a grade with its
rationale.
