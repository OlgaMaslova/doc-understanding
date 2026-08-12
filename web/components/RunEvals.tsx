/**
 * How to run the evals yourself.
 *
 * The project's whole claim is "this one you can run", and a claim like that is only
 * as good as the instructions next to it. So this is the loudest thing on the
 * reference page rather than a footnote at the bottom of it.
 *
 * The browser path comes first because it is the shorter one: three commands and then
 * everything else is clicks, with the price on the button before anything is spent.
 * The terminal path follows for the runs the browser refuses — the full matrix, every
 * document — and for the two rehearsal steps that cost nothing and catch the plumbing
 * bugs that would otherwise surface halfway through a paid run.
 *
 * The first two commands are deliberately repeated in both paths. A reader following
 * the short path should never have to scroll into the long one to find a prerequisite,
 * and two duplicated lines are cheaper than that.
 *
 * Commands are duplicated from README.md rather than imported, so they are checked
 * against the pipeline's actual argparse when either changes. The flag list mirrors
 * `precompute.py`.
 */

interface Step {
  title: string;
  note?: string;
  code: string;
}

/** The short path: get the pipeline on disk, then drive it from the page. */
const BROWSER: Step[] = [
  {
    title: "Add your keys",
    note: "ANTHROPIC_API_KEY drives every approach and the judge; VOYAGE_API_KEY covers embeddings and reranking for the two retrieval approaches. They are read server-side and never sent to the browser.",
    code: "cp .env.example .env   # then fill in both keys",
  },
  {
    title: "Install the pipeline",
    note: "The web app shells out to this. It is also the reason a deployed copy of the site can never spend anything: there is no Python environment on a serverless host.",
    code: "cd pipeline && python3 -m venv .venv && .venv/bin/pip install -e .",
  },
  {
    title: "Start the site",
    note: "No flag to set. Runs are available whenever the pipeline and a key both exist.",
    code: "cd web && npm install && npm run dev",
  },
];

const TERMINAL_SETUP: Step[] = [
  {
    title: "Keys and the pipeline, if you have not already",
    code: "cp .env.example .env\ncd pipeline && python3 -m venv .venv && .venv/bin/pip install -e .",
  },
  {
    title: "Count the documents — free",
    note: "Token counts come from the API, not an estimate: they are model-specific and they are the x-axis of the whole argument. Counting is free, and nothing else works until it has happened.",
    code: ".venv/bin/python -m docrace.documents --meta-only",
  },
];

const REHEARSE: Step[] = [
  {
    title: "Fetch and normalize the documents",
    code: ".venv/bin/python -m docrace.documents",
  },
  {
    title: "Dry run against a stubbed API — still spends nothing",
    note: "Exercises every approach end to end: a malformed request, a tool loop that never terminates, usage that fails to accumulate, an invalid extraction schema. These are the failures worth finding before a paid run, not partway through one.",
    code: ".venv/bin/python scripts/dry_run.py",
  },
  {
    title: "Price the run before committing to it",
    note: "Prints the projection with its assumptions alongside, so the number can be argued with.",
    code: ".venv/bin/python -m docrace.estimate",
  },
];

const RUN: Step[] = [
  {
    title: "One approach, smallest document — the cheapest real check",
    note: "Confirms the shape and the cost of real output before the full matrix. Use at least two questions: the cached runs need a second query before there is a cache to read, which is the thing most worth verifying.",
    code: ".venv/bin/python -m docrace.precompute --doc arxiv-paper --arm full_context --limit 2",
  },
  {
    title: "The whole matrix",
    note: "Resumable. Completed cells are skipped, and indexes, contextual prefixes, and extractions are cached on disk, so an interrupted run costs nothing to resume.",
    code: ".venv/bin/python -m docrace.precompute",
  },
];

const FLAGS: { flag: string; what: string }[] = [
  {
    flag: "DOCRACE_MODEL=<id>",
    what: "the model the approaches answer with (env var, not a flag — default claude-opus-5; must have a rate-card entry in data/pricing.json). Indexing and grading stay on claude-opus-5 regardless, so runs compare answering models and nothing else. Results land in results/<doc>.<model>.json, one file per model — measuring with a second model adds a file rather than touching the first.",
  },
  { flag: "--doc / --arm / --question", what: "narrow the run; each is repeatable" },
  { flag: "--limit N", what: "only the first N questions per document" },
  { flag: "--force", what: "re-run cells that already have results" },
  {
    flag: "--rebuild-index",
    what: "regenerate indexes, prefixes, and extractions — this costs money",
  },
  { flag: "--manifest-only", what: "just refresh results/manifest.json" },
];

function Block({ step, n }: { step: Step; n?: number }) {
  return (
    <li className="space-y-1.5">
      <p className="text-sm text-text">
        {n ? <span className="tnum mr-1.5 text-text-faint">{n}.</span> : null}
        {step.title}
      </p>
      {step.note ? (
        <p className="max-w-3xl text-sm leading-relaxed text-text-dim">
          {step.note}
        </p>
      ) : null}
      <pre className="overflow-x-auto rounded border border-border bg-bg-inset px-3 py-2 font-mono text-[11px] leading-relaxed text-text-dim">
        {step.code}
      </pre>
    </li>
  );
}

function Phase({
  title,
  blurb,
  steps,
}: {
  title: string;
  blurb: string;
  steps: Step[];
}) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-text">{title}</h4>
        <p className="mt-0.5 max-w-3xl text-sm leading-relaxed text-text-faint">
          {blurb}
        </p>
      </div>
      <ol className="space-y-4">
        {steps.map((step) => (
          <Block key={step.title} step={step} />
        ))}
      </ol>
    </div>
  );
}

export function RunEvals() {
  return (
    <section aria-labelledby="evals-heading" className="space-y-8">
      <div className="max-w-3xl space-y-3">
        <h2
          id="evals-heading"
          className="text-xl font-medium leading-snug text-text sm:text-2xl"
        >
          Run it yourself, locally
        </h2>
        <p className="text-base leading-relaxed text-text-dim">
          Every answer, cost, latency and grade this site shows came out of the
          pipeline in this repository.{" "}
          <code className="text-text-dim">results/</code> is generated, not committed,
          so a fresh clone has none of it — and can regenerate all of it against your
          own keys.
        </p>
      </div>

      {/* The short path, in a card, first. Someone deciding whether this is worth
          their afternoon should be able to see the whole commitment — three commands
          — without reading the CLI reference underneath it. */}
      <div className="space-y-4 rounded-md border border-accent bg-bg-raised p-5">
        <div className="max-w-3xl">
          <h3 className="text-base font-medium text-text">
            From the browser — the short path
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-text-dim">
            Three commands, then everything else is clicks. Choose{" "}
            <span className="text-text">Run the evals</span>, pick a document and the
            approaches, and you get the projected cost on the button before anything
            is spent. Progress streams per cell and the charts rewrite themselves with
            your numbers when it finishes.
          </p>
        </div>
        <ol className="space-y-4">
          {BROWSER.map((step, i) => (
            <Block key={step.title} step={step} n={i + 1} />
          ))}
        </ol>
        <p className="max-w-3xl text-sm leading-relaxed text-text-faint">
          Runs from the browser are capped — above the ceiling the request is refused
          with the equivalent terminal command, so a stray click cannot start the full
          matrix. Cells that already have results are skipped, so re-opening a scope
          you have run costs nothing.
        </p>
      </div>

      <div className="space-y-6 border-t border-border pt-6">
        <div className="max-w-3xl">
          <h3 className="text-base font-medium text-text">
            Or from the terminal — the whole thing
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-text-dim">
            The path with no ceiling: every document, every approach, and the two
            rehearsal steps that cost nothing and exist so the expensive one only runs
            once.
          </p>
        </div>

        <Phase
          title="Set up"
          blurb="Keys, a virtualenv, and the token counts every projection is built on. Nothing here spends anything."
          steps={TERMINAL_SETUP}
        />
        <Phase
          title="Rehearse — both of these are free"
          blurb="Every approach exercised against a stub, then the real run priced with its assumptions printed."
          steps={REHEARSE}
        />
        <Phase
          title="Run it for real"
          blurb="This is the step that spends money. Smallest scope first."
          steps={RUN}
        />

        <div className="space-y-2">
          <h4 className="text-sm font-medium text-text">Flags worth knowing</h4>
          <dl className="space-y-1">
            {FLAGS.map(({ flag, what }) => (
              <div key={flag} className="flex flex-wrap gap-x-3">
                <dt className="w-56 shrink-0 font-mono text-[11px] leading-relaxed text-text">
                  {flag}
                </dt>
                <dd className="min-w-0 flex-1 text-sm leading-relaxed text-text-dim">
                  {what}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
