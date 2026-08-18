# results/

This directory holds the precomputed comparison data the site serves. The
committed files are real measurements — currently the arXiv paper's full matrix
(7 arms × 15 questions), answered with `claude-sonnet-5`. The other documents'
files appear when someone runs them.

One file holds one measurement of one document, and what makes it distinct is in
the filename: `<doc>.<model>.json`, or `<doc>.<model>.idx-<index-model>.json` when
indexing was pinned to a model other than the one answering. Measuring a document
a second way adds a sibling file rather than touching the first, and the site
offers the choice wherever a document has more than one.

The index model earns a place in the filename because two of the six approaches —
contextual retrieval and extract-then-query — are built by it. Change it and both
their cost and the chunks they retrieve change, so those are different
measurements even when the answering model is identical. Every committed file
here was measured before indexing was selectable, when it was pinned to
`claude-opus-5`; that is why four of the five carry the `.idx-` suffix.

(Files from before this layout — bare `<doc>.json` — are renamed automatically the
next time the pipeline runs.)

Nothing here calls an API at request time. The deployed site reads these files
and serves the recorded answers, which is what makes it instant, deterministic,
and free to visit regardless of traffic.

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
`manifest.json` | One entry per (document, model) result set with completeness state and filename, plus arms, question types, grade vocabulary, pricing snapshot date |
`arxiv-paper.<model>.json` | Up to 105 cells (7 arms × 15 questions) plus per-arm economics, for one answering model |
`edgar-contract.<model>.json` | same |
`form-10k.<model>.json` | same |

Each cell holds the answer text, the delta stream with millisecond offsets, token
usage, a cost breakdown, latency, arm-specific notes, and a grade with its
rationale.
