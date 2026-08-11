# DocRace

**Everyone has an opinion about RAG vs. long context. This one you can run.**

Ask a question of a document, watch six extraction strategies answer it side by
side, and see exactly what each one cost you.

## This is not a benchmark

Three documents cannot tell you which strategy is better in general, and nothing
here claims to. DocRace is a **decision tool**. The "RAG vs. long context"
question has been answered a hundred times in prose and zero times in a form you
can poke: everyone writes the decision table, nobody lets you watch the crossover
move when you swap a 15-page paper for a 200-page 10-K. That gap is the whole
product.

The numbers are real measurements on these three documents with these questions.
Read them as measurements, not as a ranking. (A fresh clone ships no results at
all — see [results/README.md](results/README.md).)

## The two findings the demo is built around

**Prompt caching quietly deletes RAG's cost advantage on small documents.** Cache
reads price at roughly a tenth of fresh input. On the ~41k-token contract here,
keeping the entire document in context costs about the same per query as
retrieving five chunks — while being strictly more accurate, because nothing was
thrown away. RAG's cost story assumes you pay full price for context. You don't,
after the first call.

**Document size is what flips the answer, and it flips hard.** Push to the
~173k-token 10-K and cached full context costs several times what retrieval costs
per query, because cache reads scale with document size while retrieval doesn't.
The crossover is real; it just sits much further out than the blog posts imply.

Both numbers come out of the results, not out of this paragraph — the per-query
figures are on the page and in `results/`, and the chart is the argument.

A third finding falls out of the query taxonomy: **retrieval fails least often on
the queries people test it with, and most often on the ones they ship.** Needle
lookups work fine. Aggregation ("how many termination rights are there") and
absence ("what's the escalation cap" — there isn't one) are where it quietly
breaks, because retrieval always returns *something*, and something is what gets
hallucinated from.

## The six arms

Caching is **not** a retrieval strategy. It is a cost transform on the
full-context arm with essentially identical accuracy, because the prompt is
byte-identical. Presenting it as a peer strategy would be wrong; presenting it as
the same tokens at a different price is both correct and more interesting.

Six strategies, seven measured arms: arm 2 runs at both cache lifetimes. The two
variants share a colour in the UI and a `variant_of` field in the results, so they
read as one strategy measured twice rather than two unrelated strategies. Their
accuracy rows in the heatmap should be identical, since the prompts are — and if
they aren't, that's model nondeterminism, not a difference between strategies.

| # | Arm | What it does | Where it wins | Where it breaks |
|---|-----|--------------|---------------|-----------------|
| 1 | **Full context** | Whole document in the prompt, every query | Accuracy ceiling; the reference the others are read against | Cost scales linearly with queries × document size |
| 2 | **Full context + cache** | Same tokens, cached across queries. Measured at **both** cache lifetimes: 5 minutes and 1 hour | Same accuracy as #1 at ~1/10 the marginal cost | Cache TTL; still scales with document size |
| 3 | **Naive chunk RAG** | Fixed-size chunks, embedding search, top-5 | Cheap, flat cost regardless of document size | Aggregation, multi-hop, absence |
| 4 | **Hybrid + contextual** | BM25 + embeddings, LLM-written chunk prefixes, reranked | The honest RAG baseline; recovers most of naive RAG's losses | A real indexing bill that scales with document size |
| 5 | **Agentic search** | Model gets grep/read tools over the document, iterates | Multi-hop; doesn't need the whole document in context | Slowest by far, and cost varies per query |
| 6 | **Extract then query** | One map-reduce pass into a schema; queries hit the structured output | Near-zero marginal cost; unbeatable on aggregation | Answers only what the schema anticipated |

**Arm 4 is not optional.** A strawman RAG arm would make the whole project
suspect — of course full context wins if the retrieval is undertuned. Its
parameters are documented below so the tuning is auditable.

**Arm 6 is the sleeper.** It reframes the question from "which strategy is best"
to "do you know your questions in advance?" — which is the decision most teams
are actually facing.

## Query taxonomy

Every preset question carries a type tag. This is the second axis of the heatmap
and where the real differentiation lives.

| Type | Example | Why it discriminates |
|------|---------|---------------------|
| **Needle** | "What is the governing law?" | Everything passes. Establishes the floor. |
| **Multi-hop** | "How did the largest segment's margin change YoY?" | Requires joining distant facts; retrieval gets one hop |
| **Aggregation** | "How many termination rights does either party have?" | Requires seeing the whole document; top-k structurally cannot |
| **Global** | "What is this document's overall position on X?" | No single passage contains the answer |
| **Absent** | "What is the escalation cap?" (there isn't one) | Tests refusal against hallucination — the most underrated cell in the matrix |

## Architecture

```
 pipeline/  (Python, offline)          results/  (generated JSON)      web/  (Next.js)
 ─────────────────────────────         ─────────────────────────      ───────────────
 documents  → normalize, count    ─→   <doc>.json   per q x arm  ─→   /api/race  SSE
 chunking   → 500/50 token chunks       manifest.json                  replays recorded
 retrieval  → numpy vectors, BM25                                      deltas at their
 contextual → LLM chunk prefixes                                       original pacing
 arms/      → the six strategies                                            │
 grading    → judge vs ground truth                                        ▼
 precompute → CLI, resumable                                     race view + 2 charts
```

**The single most important engineering decision: precompute everything.** Every
preset question × arm result is computed once, offline, and written to `results/` as JSON —
answer text, delta timings, token counts, latency, cost, grade. The deployed site
runs in **replay mode**: instant, deterministic, and free to visit. Without it,
one post to the front page empties the account in an afternoon.

### Stack

- **Frontend:** Next.js + Tailwind, SSE for the race stream, hand-rolled SVG
  charts. A handful of series and two chart types do not justify a charting dependency,
  and the charts are part of what's being judged.
- **Pipeline:** Python. Offline only — it writes JSON, it does not serve
  requests.
- **Vectors:** numpy, in memory. **No pgvector.** Three documents do not need a
  vector database, and standing one up would be exactly the cargo-culting this
  project is an argument against.
- **Grading:** pre-graded against committed ground truth. The deployed site never
  grades anything.

## Methodology

Everything below is a knob someone could reasonably disagree with, which is why
it's written down rather than left in the code.

### Model and pricing

All arms run on `claude-opus-5` with default adaptive thinking. Streaming is used
throughout, both because non-streaming requests at these `max_tokens` risk HTTP
timeouts and because the delta arrival times are what replay mode replays.

Prices live in exactly one place, [`data/pricing.json`](data/pricing.json), and
every result is stamped with that file's `snapshot_date`, which the UI displays.
Model prices change often enough that hardcoded numbers rot; when they change,
edit that file and re-run.

### Chunking (arms 3 and 4)

~500-token chunks with ~50 tokens of overlap. Chunks are split at paragraph
boundaries first and sentence boundaries second, so a chunk rarely severs a
sentence or a table row. Arms 3 and 4 share the same segmentation, so the only
difference between them is retrieval quality.

### Arm 3 — naive chunk RAG

Voyage embeddings over the raw chunks, cosine similarity, top 5. No reranking, no
query rewriting. This is deliberately the thing most people actually ship first.

### Arm 4 — hybrid retrieval with contextual prefixes

1. **Contextual prefixes at index time.** For each chunk, a `claude-opus-5` call
   writes one or two sentences situating it within the document, with the full
   document sent as a cached prefix. Chunks are batched (20 per call) and the
   output is schema-constrained, so a 400-chunk document is ~20 calls rather than
   400. This matters: a chunk that reads "revenue increased 12% to $4.2 billion"
   is unmatchable without knowing whose revenue, which segment, and which year.
2. **Dual retrieval.** BM25 over the prefixed chunks, and Voyage embeddings over
   the same, each returning 20 candidates.
3. **Fusion.** Reciprocal rank fusion, k=60. RRF needs no score normalization
   between the two systems, which is why it's the right choice when one side is
   cosine similarity and the other is BM25 — their scales aren't comparable.
4. **Reranking.** Voyage `rerank-2.5` over the fused candidates, top 5 into the
   prompt.

The prefix generation is a real indexing bill that scales with document size. It
shows up as arm 4's y-intercept on the cost chart, not as a footnote.

### Arm 5 — agentic search

Two tools over the raw document: `grep(pattern)` (case-insensitive regex,
returning numbered lines, capped at 40 matches) and `read_lines(start, end)`
(capped at 200 lines). Iteration cap of 15. Usage is summed across the entire
loop, and the per-question call count is recorded — cost variance per query is a
finding, not noise to average away.

### Arm 6 — extract then query

One map-reduce pass: the document is split into ~120k-character windows with 4k
of overlap, each extracted into the domain schema via structured outputs, then
merged in a final call. Queries afterwards see only the merged record.

The schemas in [`data/schemas/`](data/schemas/) are the crux of this arm's
honesty. They were written as what a competent engineer would build *before*
seeing the question set — the fields cover what a contracts reviewer, an analyst,
or a paper reader normally wants — and were **not** reverse-engineered from the
questions. If they had been, arm 6 would win everything and mean nothing.

### Caching

Caching is applied to **every arm that has a stable prefix worth caching**, not
only to arm 2. This matters for the same reason arm 4 has to be properly tuned: if
one arm gets the cost transform and the others don't, arm 2's advantage is an
artifact of selective effort rather than a finding. Where each arm stands:

| Arm | Cached prefix | TTL | Warm is |
|---|---|---|---|
| 1 Full context | none, by definition | — | — |
| 2 Full context + cache | the document | 5m **and** 1h, measured separately | one-time |
| 3 Naive RAG | nothing worth caching — retrieved chunks differ every query, and the system prompt alone is below the minimum cacheable length | — | — |
| 4 Hybrid + contextual | the document, during the indexing pass only | 1h | one-time (indexing) |
| 5 Agentic search | the growing conversation | 5m | **per query** |
| 6 Extract then query | the extracted record | 1h | one-time |

Two details are load-bearing.

**Where the breakpoint goes.** Caching is a prefix match, so anything that varies
must come after the breakpoint. In arm 2 the document sits in `system` behind the
breakpoint and the question goes in `messages`, which renders after it — so the
cached prefix is byte-identical across all fifteen questions. There is no maximum
size behind a single breakpoint, so even the 10-K needs exactly one; splitting
would only create entries at prefix lengths nothing ever requests. Arm 6 needed
the record and the question in **separate content blocks**, because concatenated
into one string there is nowhere to put a breakpoint and the record gets re-billed
at full price on every question.

**Arm 5's warm is marginal, not fixed.** The other cached arms share one warm
across every question, so it belongs in the cost chart's intercept. Arm 5 starts a
fresh conversation per question, so it warms its own cache every time and the cost
belongs in the slope. Folding it into the intercept would make agentic search look
several times cheaper per query than it is. `ARM_CACHE_SHARED_ACROSS_QUERIES` in
[`arms/__init__.py`](pipeline/docrace/arms/__init__.py) is what encodes that
distinction, and `cache_write_shared` in the results records which reading applies.

Arm 5 also uses **two** breakpoints rather than one. A single trailing breakpoint
is enough in the normal case — a turn adds three or four content blocks and the
lookback walks back twenty positions to find the previous turn's write — but it
stops being enough when the model issues a burst of parallel tool calls, since
each contributes both a `tool_use` and a `tool_result` block. The second sits a
turn further back as insurance and costs nothing extra, because that position is
already cached. Breakpoints go only on `tool_result` blocks, which the arm
constructs itself; assistant turns are echoed back verbatim because thinking
blocks must not be edited.

### Why arm 2 is measured at both TTLs

The spec names "Cache TTL" as where arm 2 breaks, and a footnote is a weak way to
say so. So the arm runs twice — identical prompts, differing only in the `ttl` on
the breakpoint — and the results record what each lifetime actually cost.

The 5-minute cache writes at 1.25× input, the 1-hour at 2×, so the cheaper write
gives a lower intercept. But the 5-minute cache only holds if queries keep
arriving inside a five-minute window; let it lapse and the next query pays the
write again, and a strategy that re-warms the whole document every few queries is
barely a cached strategy. The per-query cache-read rate is identical under both,
so the entire difference is how often you pay to warm.

That's now visible rather than asserted: `cache_write_count` in the results says
how many times each variant warmed during its fifteen-question run, and the
summary table marks any arm that warmed more than once. If the 5-minute variant
re-writes mid-run, that is the finding, not a glitch — and it's the reason the rest
of the pipeline uses the 1-hour cache, where a slow run can't quietly corrupt the
marginal-cost figure.

### Grading

A `claude-opus-5` judge compares each answer to committed ground truth with a
five-value vocabulary: correct, partial, incorrect, hallucinated, and correctly
refused. The last two matter most. An arm that says "the document does not
address this" when the document indeed does not is doing the right thing, and an
arm that produces a confident number instead is doing the single worst thing;
collapsing those into "incorrect" would hide the finding.

Judge rationales are kept in the results JSON, so a wrong call is visible and can
be corrected by hand before results are committed.

### The answer key is on the page

Every grade is shown next to the reference answer it was assigned against —
including the verbatim quote from the document that the reference answer rests on,
and for `absent` questions the list of phrases confirmed *not* to appear.

This is not decoration. A tool whose entire argument is *"don't take a blog post's
word for it, run it yourself"* cannot then ask the reader to accept its grades on
faith. If the judge marks an answer wrong and you disagree, you should be able to
see immediately who is right. The quotes are checked verbatim against the source
text by `check_questions.py` before any run, so the answer key is auditable too,
not just the answers.

Each arm's card also carries a **"How it got there"** disclosure showing what that
arm actually did: which chunks retrieval returned, how many grep/read iterations
the agentic arm took, whether the cache was hit. When a retrieval arm gets an
aggregation question wrong, the chunks it retrieved *are* the explanation, and
without them the heatmap is a scoreboard rather than something you can interrogate.

### The cost chart applies an accuracy floor

The "cheapest at N queries" row only recommends arms scoring **80% or better**,
and says so in the label.

Ranking on cost alone crowns whichever arm is most willing to be wrong — on the
10-K that is naive chunk RAG, which would be printed as the answer while scoring
57%, directly contradicting the heatmap immediately below it. Where the floor
changes the answer, the row also names the cheaper arm it passed over and that
arm's score, so the trade is visible rather than quietly made on the reader's
behalf. Every arm's true cost is still drawn on the chart; the floor governs the
recommendation, not the data.

The floor of 0.8 is a judgement call, not a standard, which is why the number is
on screen.

Below the row, the chart states the comparison the project exists to make in
words — cached full context against the cheapest retrieval arm, per query — and it
changes with the document:

| Document | Ratio | What the chart says |
|---|---|---|
| Paper (~17k) | 0.75× | Caching is *cheaper* than retrieval; it has erased retrieval's cost advantage |
| Contract (~41k) | 1.13× | About parity — where the cost argument for retrieval stops working |
| 10-K (~173k) | 3.64× | The crossover has been passed; retrieval starts earning its accuracy cost |

Every pairwise crossing is still marked with a dot, but leaving the one that
matters to be found among twenty dots buried it.

## Running it

`results/` is **empty in a fresh clone** — the precomputed JSON is generated, not
committed. Populate it with fixtures (free, synthetic) or a real run (costs money);
see [results/README.md](results/README.md) for the difference and
[LICENSE](LICENSE) for the source documents' terms.

### Prerequisites

```sh
cp .env.example .env   # then fill in both keys
```

`ANTHROPIC_API_KEY` (or `ant auth login`) drives every arm and the judge;
`VOYAGE_API_KEY` covers embeddings and reranking for arms 3 and 4. Only the
offline pipeline reads them — the site itself is replay-only and needs no keys.

### Pipeline

```sh
cd pipeline
python3 -m venv .venv && .venv/bin/pip install -e .

# Fetch and normalize the three source documents.
.venv/bin/python -m docrace.documents

# Exercise every arm against a stubbed API. Spends nothing, and catches the
# plumbing bugs — a malformed request, a tool loop that doesn't terminate, usage
# that fails to accumulate, an invalid schema — that would otherwise surface
# partway through a paid run. Also validates the extraction schemas.
.venv/bin/python scripts/dry_run.py

# Project what the run will cost, with the assumptions printed alongside.
.venv/bin/python -m docrace.estimate

# Then one real arm on the smallest document, to check the shape and the cost
# before committing to the full run.
.venv/bin/python -m docrace.precompute --doc arxiv-paper --arm full_context

# Full run. Resumable: completed cells are skipped, so an interrupted run costs
# nothing to resume. Indexes, prefixes, and extractions are cached on disk.
.venv/bin/python -m docrace.precompute
```

Useful flags: `--doc` / `--arm` / `--question` to narrow, `--force` to re-run
completed cells, `--rebuild-index` to regenerate indexes and extractions (this
costs money), `--manifest-only` to just refresh `results/manifest.json`.

### Reproducing the results from the browser

Everything on the page came out of the pipeline in this repository, and you can
regenerate it with your own keys — including from the UI, in a local clone:

```sh
cd web && DOCRACE_ENABLE_RUNS=1 npm run dev
```

The panel at the bottom of the page lets you pick arms and a question count, shows
what that scope would cost, and requires a second click before spending anything.
Progress streams per cell as it runs.

Three gates have to pass before a single token is spent, and a hosted copy of this
site fails all three:

| Gate | Why |
|---|---|
`DOCRACE_ENABLE_RUNS=1` | Opt-in, so a deployed instance can never spend. Off by default. |
`pipeline/.venv` exists | Runs need the Python pipeline; a serverless host has no Python. |
A key in the environment or `.env` | Read server-side, never sent to the browser, never logged. |

A **$5 ceiling** applies to runs started from the browser. Above that the request
is refused with the equivalent CLI command, so a stray click cannot start the $71
matrix. The ceiling constrains the button, not the pipeline — the terminal has no
limit. The server re-prices every scope itself, so the number shown in the panel is
information rather than a security boundary.

There is deliberately **no bring-your-own-key path**. Accepting a visitor's
credential over HTTP means owning the handling of somebody else's secret, and this
project has no need to. Live mode with BYO keys is the roadmap's v1 item and needs
a rate limit before it exists.

Note that a run **discards fixture cells rather than resuming onto them**. Synthetic
and measured cells merged into one file, stamped as measurement, is the outcome all
the provenance marking exists to prevent.

### Web

```sh
cd web
npm install
npm run dev
```

The app reads `results/` from disk. To review the UI without spending anything,
`pipeline/scripts/make_fixtures.py` writes plausible fake results in the same
shape; a real precompute run overwrites them.

## Source documents

One per domain, chosen so token counts span more than an order of magnitude —
size is what moves the crossover.

| Domain | Document | ~Tokens | Licensing |
|--------|----------|---------|-----------|
| Scientific | [Mamba: Linear-Time Sequence Modeling with Selective State Spaces](https://arxiv.org/abs/2312.00752) (Gu & Dao), arXiv:2312.00752v2 | ~17k | CC BY 4.0 |
| Legal | License Agreement between Processa Pharmaceuticals and Ocuphire Pharma — Exhibit 10.1 to Ocuphire's Form 8-K filed 2021-06-23 | ~41k | U.S. public filing |
| Financial | Ford Motor Company Annual Report on Form 10-K, FY2025, filed 2026-02-11 | ~173k | U.S. public filing |

Provenance and licensing are recorded in `data/docs/<doc_id>.json` and shown in
the UI. Two notes on the choices:

**The arXiv paper's license was verified on the abstract page**, which links
`creativecommons.org/licenses/by/4.0/` rather than printing the license name — a
programmatic check has to look at the href, not visible text. Most well-known ML
papers are under arXiv's default non-exclusive license, which is not
redistributable; this one is not. Note also that `/html/2312.00752v1` 404s
because v1 predates arXiv's HTML rollout, so the URL pins v2.

**The contract was chosen because it is unredacted.** Nearly every post-2019
pharma license exhibit blanks its economics under Reg S-K 601(b)(10)(iv), and a
contract with `[***]` where the milestone payments should be cannot support an
aggregation question about payment terms. This one has the full milestone table,
sales-milestone tiers, and royalty rates intact.

### Normalization

All three are HTML and are stripped to plain text by
[`documents.py`](pipeline/docrace/documents.py). Three details earn their
complexity:

- **Inline-XBRL headers are dropped.** A 10-K opens with an `ix:header` carrying
  every context reference in the document — roughly 110k characters of machine
  tagging before a word of prose. Left in, it would inflate the token count by
  more than half.
- **MathML annotations are dropped.** arXiv's HTML carries both rendered glyphs
  and the original LaTeX for every formula; keeping both turns `x_t` into
  `xtx_{t}`, which is noise in the prompt and poison for BM25.
- **Long lines are wrapped at 180 characters.** Stripping a 10-K's layout markup
  leaves a few lines over a hundred thousand characters long. That breaks the
  agentic arm specifically — a `grep` hit is only useful if the line it returns is
  readable.

Table structure survives imperfectly, which is what a regex stripper over 10-K
HTML gets you. Every figure survives and rows stay intact; column alignment is
approximate. All arms read the same text, so the comparison stays fair.

## Roadmap

- **v0** — 3 documents, 6 arms, replay mode, race view and both charts. The
  shippable core. ← *this*
- **v1** — Live mode with bring-your-own key, custom questions, LLM-judge
  grading. Do not deploy live mode without a rate limit.
- **v2** — Upload your own document; the tool estimates cost per arm before you
  spend anything. *This is the version people actually use,* and the estimator is
  the part with standalone utility.
- **v3** — Model matrix: swap the underlying model, watch the crossover move
  again. Cheap to add, high demo value.
- **v4** — Plugin API for contributed arms, CI that reruns the matrix when a new
  model ships.

## Risks, named honestly

- **"This is just a benchmark with n=3."** Correct, which is why it never claims
  to be one. The caveat is above the fold, not in a footnote.
- **Weak RAG arms would invalidate everything.** Arm 4 is tuned properly and its
  parameters are documented above so the tuning is auditable.
- **Public cost.** Replay mode solves this. Do not deploy live mode without a
  rate limit.
- **Pricing drifts.** One config file, results stamped with its date, date shown
  in the UI.
- **Scope creep into a RAG framework.** The product is the comparison, not the
  retrieval library. If arm 4 starts growing a plugin system before v4, that's
  the failure mode.

## The question set

Forty-five questions: fifteen per document, three in each of the five taxonomy
types. They live in [`data/questions.yaml`](data/questions.yaml) alongside their
ground truth and grading notes.

Two fields exist purely as provenance for the answer key, and
[`scripts/check_questions.py`](pipeline/scripts/check_questions.py) enforces
them:

- Every non-absent question carries a `quote` that is grepped against the source
  text. If a citation does not appear in the document, the check fails.
- Every absent question carries `absent_terms`, each of which the check confirms
  is genuinely missing from the document.

The second one is the important one. A question that claims the document is
silent, when it is not, would invert the grade for every arm at once — an
error that grading cannot catch, because the judge only sees the answer key.
Absence is therefore verified mechanically rather than asserted. That check has
already earned its keep: one draft absence claim turned out to be wrong.

Neither field is passed to the judge; only `ground_truth` and `grading_notes`
are.
