import { RepoLink } from "./RepoLink";
import { REPO_URL } from "@/lib/site";

/**
 * Where running it actually happens.
 *
 * The site used to be able to run the evals: pick a scope, see the projected cost on
 * the button, watch it measure, and the charts rewrote themselves with your numbers.
 * That needed a Python pipeline and a key on the machine serving the page, which a
 * static host has neither of — so this branch dropped the flow rather than shipping a
 * button that fails on click.
 *
 * What is left is the honest version: the claim the project rests on is "you can run
 * this", and this is the section that says where. Commands are the shape of the
 * commitment rather than a reference — the full CLI, with every flag, is in the
 * repository next to the code that parses it, which is the only copy that cannot go
 * stale.
 */
export function RunItYourself() {
  return (
    <section aria-labelledby="run-heading" className="space-y-6">
      <div className="max-w-3xl space-y-3">
        <h2
          id="run-heading"
          className="text-xl font-medium leading-snug text-text sm:text-2xl"
        >
          If you want to run it yourself
        </h2>
        <p className="text-base leading-relaxed text-text-dim">
          Every answer, cost, latency and grade this site shows came out of the
          pipeline in this project&apos;s repository, and this deployment is a
          recording of one set of runs. Nothing here can start another: it is static
          files on a static host, with no pipeline behind them and no key. A clone can.
        </p>
      </div>

      <div className="space-y-4 rounded-md border border-accent bg-bg-raised p-5">
        <div className="max-w-3xl space-y-2">
          <h3 className="text-base font-medium text-text">
            Clone it, price it, then spend
          </h3>
          <p className="text-sm leading-relaxed text-text-dim">
            An Anthropic key and a Voyage key, a virtualenv, and one free command that
            says what a run would cost before you start one. Nothing below spends
            anything — <span className="font-mono text-text-dim">estimate</span>{" "}
            projects, it does not measure.
          </p>
        </div>
        <pre className="overflow-x-auto rounded border border-border bg-bg-inset px-3 py-2 font-mono text-[11px] leading-relaxed text-text-dim">
          {`git clone ${REPO_URL}.git
cd ${REPO_URL.split("/").pop()} && cp .env.example .env   # then fill in both keys
cd pipeline && python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/python -m docrace.estimate                      # free: what a run would cost`}
        </pre>
        <p className="max-w-3xl text-sm leading-relaxed text-text-faint">
          The command that spends is{" "}
          <span className="font-mono text-text-dim">docrace.precompute</span>, and it
          spends whatever scope you give it — one document, one approach, two questions
          is the cheapest real check, at well under a dollar; leave the flags off and
          it measures everything, which is tens of dollars. Then{" "}
          <span className="font-mono text-text-dim">cd web &amp;&amp; npm run dev</span>{" "}
          serves this same page against the results you just produced.{" "}
          <RepoLink>Everything is in the README</RepoLink>: every flag, what each
          approach does, how a grade is decided, and what the whole matrix costs per
          document. The default branch also drives runs from the page, pricing each
          scope on the button — the part a static deployment like this one cannot do.
        </p>
      </div>
    </section>
  );
}
