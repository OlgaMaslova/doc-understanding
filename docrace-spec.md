# DocRace — project spec

**One line:** Ask a question of a document, watch six extraction strategies answer it side by side, and see exactly what each one cost you.

---

## Positioning (read this first)

With three example PDFs, this is **not a benchmark** and must never call itself one. Three documents cannot support a claim about which strategy is better in general, and framing it as a benchmark invites the one criticism you can't answer.

What it *is*: an **interactive decision tool**. The "RAG vs. long context" question has been answered a hundred times in prose and zero times in a form you can poke. Everyone writes the decision table; nobody lets you *watch the crossover move* when you swap a 15-page paper for a 214-page 10-K. That gap is the whole product.

Positioning line for the README: *"Everyone has an opinion about RAG vs. long context. This one you can run."*

---

## The insight the product is built around

Two findings drive every design decision below. Both are non-obvious, both are defensible, and both are things a reader will remember a week later.

**1. Prompt caching quietly deletes RAG's cost advantage on small documents.** Cache reads price at roughly a tenth of fresh input. On a 30k-token contract, keeping the entire document in context costs about the same per query as retrieving five chunks — while being strictly more accurate, because nothing was thrown away. RAG's cost story assumes you pay full price for context. You don't, after the first call.

**2. Document size is what flips the answer, and it flips hard.** Push to a 182k-token 10-K and cached full-context costs roughly 5× what retrieval costs per query, because cache reads scale with document size while retrieval doesn't. The crossover is real; it just sits much further out than the blog posts imply.

The demo's job is to make both legible in about eight seconds: switch documents, watch the lines reorder.

A third finding falls out of the query taxonomy and is worth surfacing: **retrieval fails least often on the queries people test it with, and most often on the ones they ship.** Needle lookups work fine. Aggregation ("how many termination rights are there") and absence ("what's the escalation cap" — there isn't one) are where it quietly breaks, because retrieval always returns *something*, and something is what gets hallucinated from.

---

## The six arms

Note that **caching is not a retrieval strategy** — it's a cost transform on the full-context arm, with essentially identical accuracy. Presenting it as a peer strategy is a mistake reviewers catch; presenting it as the same tokens at a different price is the correct framing and is more interesting anyway.

| # | Arm | What it does | Where it wins | Where it breaks |
|---|-----|--------------|---------------|-----------------|
| 1 | **Full context** | Whole document in the prompt, every query | Accuracy ceiling; the reference the others are scored against | Cost scales linearly with queries × document size |
| 2 | **Full context + cache** | Same tokens, cached across queries | Same accuracy as #1 at ~1/10 the marginal cost | Cache TTL; still scales with document size |
| 3 | **Naive chunk RAG** | Fixed-size chunks, embedding search, top-k | Cheap, flat cost regardless of document size | Aggregation, multi-hop, absence |
| 4 | **Hybrid + contextual retrieval** | BM25 + embeddings, LLM-written chunk prefixes, reranked | The honest RAG baseline; recovers most of naive RAG's losses | Real indexing bill that scales with document size |
| 5 | **Agentic search** | Model gets grep/search tools over the document, iterates | Multi-hop; doesn't need the whole doc in context | Slowest by far, and cost varies per query |
| 6 | **Extract-then-query** | One map-reduce pass into a schema; queries hit the structured output | Near-zero marginal cost; unbeatable on aggregation | Answers only what the schema anticipated |

**Arm 4 is not optional.** A strawman RAG arm makes the entire project suspect — of course full-context wins if the retrieval is naive. Tuning arm 4 honestly is what separates this from the blog posts.

**Arm 6 is the sleeper.** It reframes the question from "which strategy is best" to "do you know your questions in advance?" — which is the actual decision most teams face.

---

## Query taxonomy

Every preset question carries a type tag. This is the second axis of the heatmap and where the real differentiation lives.

| Type | Example | Why it discriminates |
|------|---------|---------------------|
| **Needle** | "What is the governing law?" | Everything passes. Establishes the floor. |
| **Multi-hop** | "How did the largest segment's margin change YoY?" | Requires joining distant facts; retrieval gets one hop |
| **Aggregation** | "How many termination rights does either party have?" | Requires seeing the whole document; retrieval structurally cannot |
| **Global** | "What is this document's overall position on X?" | No single passage contains the answer |
| **Absent** | "What is the escalation cap?" (there isn't one) | Tests refusal vs. hallucination — the most underrated cell in the matrix |

---

## Architecture

```
 ┌──────────────┐     ┌─────────────────────────┐     ┌──────────────┐
 │  Next.js UI  │◄────┤  /api/comparison (SSE)  │◄────┤  Arm runners │
 │  race view   │     │  fan-out, stream deltas │     │  (Python)    │
 └──────────────┘     └─────────────────────────┘     └──────────────┘
        │                        │                            │
        │                        ▼                            ▼
        │              ┌──────────────────┐         ┌──────────────────┐
        └─────────────►│  replay store    │         │  numpy vectors   │
                       │  (precomputed    │         │  BM25 index      │
                       │   JSON per q×arm)│         │  extracted schema│
                       └──────────────────┘         └──────────────────┘
```

**The single most important engineering decision: precompute everything.**

Every preset question × arm result is computed once, offline, and committed as JSON — answer text, token counts, latency, cost, grade. The deployed site runs in **replay mode** by default: instant, deterministic, free to visit. A **live mode** toggle accepts a bring-your-own key for custom questions.

Without this, one post to Hacker News empties your account in an afternoon. With it, the demo survives the front page and still loads in 200ms. This is also the detail that reads as "this person has shipped something before" — it is exactly the consideration that separates a portfolio project from a portfolio project someone can actually click.

### Stack

- **Frontend:** Next.js + Tailwind, SSE for the race stream, hand-rolled SVG charts (no chart lib — six series and two chart types don't justify the dependency, and the charts are part of what's being judged)
- **Backend:** FastAPI for the arm runners; Python for the retrieval ecosystem
- **Vectors:** numpy, in memory. **Do not stand up pgvector.** Three documents do not need a vector database, and reaching for one reads as cargo-culting to exactly the audience you're trying to impress.
- **Grading:** pre-graded ground truth for the preset questions; LLM-judge only in live mode

---

## Source documents

One per domain, chosen so that document size varies by more than an order of magnitude — because size is what moves the crossover.

| Domain | Suggested source | ~Tokens | Licensing |
|--------|-----------------|---------|-----------|
| Scientific | An arXiv paper under CC-BY | ~12k | Safe to redistribute; check the specific paper's license |
| Legal | A material contract exhibit from SEC EDGAR | ~31k | Public filing |
| Financial | A Form 10-K | ~182k | Public filing |

EDGAR and CC-BY arXiv are both safe to commit to a public repo. Avoid anything scraped from a vendor's site.

---

## Roadmap

- **v0** — 3 documents, 6 arms, replay mode, race view + both charts. This is the shippable core.
- **v1** — Live mode with bring-your-own key, custom questions, LLM-judge grading.
- **v2** — Upload your own document; the tool estimates cost per arm before you spend anything. *This is the version people actually use.*
- **v3** — Model matrix: swap the underlying model, watch the crossover move again. Cheap to add, high demo value.
- **v4** — Plugin API for contributed arms, CI that reruns the matrix when a new model ships. This is the version that stops being a portfolio project and starts being infrastructure.

Ship v0 and write the post. v2 is where to spend the second burst of effort — the estimator is the part with standalone utility.

---

## Risks, named honestly

- **"This is just a benchmark with n=3."** Correct, which is why it never claims to be one. Say "decision tool" everywhere and put the caveat above the fold, not in a footnote.
- **Weak RAG arms invalidate everything.** Budget real time for arm 4. Document the chunking, the reranker, and the parameters in the README so the tuning is auditable.
- **Public cost.** Replay mode solves this. Do not deploy live mode without a rate limit.
- **Pricing drifts.** Model prices change often enough that hardcoded numbers rot. Keep pricing in one config file, stamp the results with the date they were computed, and show that date in the UI.
- **Scope creep into a RAG framework.** The product is the comparison, not the retrieval library. If arm 4 starts growing a plugin system before v4, that's the failure mode.
