---
name: publish-results
description: Publish measurements from `main` to the `static-pages` branch, which deploys the live site to GitHub Pages. Use this whenever the user wants new results to show up on the deployed page — "publish this", "deploy the new results", "push it live", "the site still shows the old numbers", "sync results to static-pages", "update the live page" — and also right after a `docrace.precompute` run finishes, when results have just been committed to `main` and the obvious next question is getting them onto the site. Handles the branch sync, the commit message, deletions of superseded result sets, and verifying the deploy actually landed. Reach for this rather than hand-rolling git commands: the two branches diverge deliberately, and the wrong git operation here (a merge) makes a mess that takes a while to unpick.
---

# Publishing measurements to the live site

The repository has two long-lived branches that are *supposed* to disagree:

- **`main`** — the full project, including the in-browser run flow (`/api` routes, `RunPanel`, the runner that shells out to Python).
- **`static-pages`** — the same project with that flow removed and `output: "export"` turned on, because GitHub Pages serves files and runs nothing. Pushing it triggers `.github/workflows/pages.yml`, which builds `web/out/` and deploys.

Runs happen on `main`; the site is built from `static-pages`. So a new measurement has to cross the branch boundary, and exactly two directories are allowed to cross:

| Path | Why it crosses |
|---|---|
| `results/` | The measurements themselves, plus `manifest.json`, which every chart, picker and caption is derived from. |
| `data/docs/` | Document metadata — title, token count, licence, provenance. The document picker names catalogued documents whether or not they have results, so a newly fetched document needs this even before it is measured. |

Nothing else. Code changes travel by cherry-pick, deliberately, as their own piece of work — never as a side effect of publishing numbers.

`results/` publishes whole, including sets that are only partly measured. That can feel wrong — shipping a run that got 30 of 105 cells looks like shipping something unfinished — but the site was built for it: a partial set is badged `partial · 30/105` on the document picker, and its charts carry a line saying the numbers are real and the aggregate is a spot check rather than a result. Withholding a set instead means committing a manifest that names files the branch does not have, which fails the build at `web/scripts/build-replay.mjs` on purpose. If a measurement genuinely should not be visible, remove it on `main` and publish after that.

## Why not just merge `main`

Because the branches differ in a dozen files *on purpose* — `web/app/page.tsx`, `next.config.ts`, `package.json`, `ArmCard.tsx`, `ComparisonView.tsx`, both READMEs, `.env.example`, `.gitignore` — and a merge asks you to resolve every one of those conflicts, in favour of the static branch, every single time you publish. Resolve one wrong and the deployed site grows a run button that 404s. Taking two directories out of `main` has no such failure mode: the tree either changes in `results/`/`data/docs/` or it doesn't.

## The steps

Run these from the repository root. Read what each one prints before moving on — the interesting failures all announce themselves.

### 1. Look at what is uncommitted, and land a fresh run on `main` first

```sh
git status --porcelain
git rev-parse --abbrev-ref HEAD
```

Note the current branch so you can return to it at the end. Then read the dirt, because there are two very different kinds:

**A run that has not been committed yet** — the modified paths are all inside `results/` or `data/docs/`, which is what `docrace.precompute` writes. This is the normal state right after a run, and asking the user to go commit it by hand before coming back is a pointless errand. Commit it on `main` yourself:

```sh
git checkout main            # if you are not already there
git add results data/docs
python3 .claude/skills/publish-results/scripts/summarize.py --verb Record > /tmp/run-msg.txt
git commit -F /tmp/run-msg.txt
git push
```

Measurements have to exist on `main` before they are published, and not as bookkeeping: carrying uncommitted results across to `static-pages` and committing them *there* would put numbers on the live site that exist in nobody's clone of the project. For a tool whose entire argument is "don't take my word for it, run it yourself", a figure on the page with no committed measurement behind it is the one bug that would actually matter.

**Anything else** — a modified component, a half-edited README, a stray script. Stop and show the user what it is. This flow switches branches twice, and uncommitted work in a file that differs between the branches is how someone's afternoon gets deleted.

Untracked build output — `web/out/`, `web/.next/`, `web/public/replay/` — is neither, and no reason to stop. It is a reason to stage `results` and `data/docs` by name rather than `git add -A`: `web/public/replay/` is regenerated by `web/scripts/build-replay.mjs` on every build and gitignored on `static-pages`, so committing it would be a stale second copy of the measurements.

### 2. Make sure `main` has what you are publishing, and that the remote has it too

```sh
git fetch origin
git log --oneline origin/main..main -- results data/docs   # unpushed measurements
git log --oneline main..origin/main -- results data/docs   # measurements you don't have
```

Publish from a `main` that is pushed — including the commit you may have just made in step 1. The deployed site and the repository someone clones should tell the same story. If `main` has unpushed result commits, push `main` first. If `origin/main` is ahead, fast-forward before publishing so you are not publishing yesterday's set.

### 3. Get onto `static-pages`, current with the remote

```sh
git checkout static-pages
git pull --ff-only
```

`--ff-only` because a diverged `static-pages` means someone published from elsewhere; merging blindly is the thing this whole skill is avoiding. If it refuses, stop and show the user the divergence.

### 4. Take the two directories from `main`

```sh
git checkout main -- results data/docs
```

This stages what it copies, so there is no `git add` to follow it with — and no temptation to reach for `git add -A`, which is how build output and editor droppings get into a publish.

It is additive, though: it copies files in and updates ones that changed, but a file `main` *deleted* stays behind. That matters because superseded result sets do get removed — a document remeasured with a newer model, an abandoned partial run. Catch those explicitly:

```sh
comm -13 \
  <(git ls-tree -r --name-only main -- results data/docs | sort) \
  <(git ls-tree -r --name-only HEAD -- results data/docs | sort)
```

Anything it lists exists on `static-pages` and not on `main`. Remove those with `git rm`, which also stages:

```sh
git rm results/<the superseded set>.json
```

It is also *directory-wide*, which is not the same as measurement-wide. Only `*.json` result sets and `manifest.json` belong in a publish; anything else `results/` happens to contain gets copied along with them. So look at what you just staged:

```sh
git diff --cached --name-only
```

In this repository that reliably catches one file: **`results/README.md`**, which the two branches disagree about on purpose — `static-pages` rewrote it to say the browser run flow is not on this branch, and `main`'s copy tells readers to run evals from the UI. Publishing `main`'s version puts those instructions on the branch built to have no such flow. If it appears in the list, put it back:

```sh
git checkout HEAD -- results/README.md
```

Same move for anything else non-measurement that shows up. This is not a one-off to remember: `git checkout main -- results` re-stages that README on *every* publish.

### 5. Stop if there is nothing to publish — and look at what is there

```sh
git diff --cached --stat
```

Empty means the site is already showing these measurements. Say so and stop — do not make an empty commit, and do not push. "Already published" is a perfectly good outcome and the most common one when someone runs this twice.

Not empty means read the list before committing, because this is the last point where a stray file is cheap to remove. Every entry should be a result set or `manifest.json`. If anything else is there — a README, a component, a script — take it out with `git checkout HEAD -- <path>` and say so when you report back.

### 6. Write a commit message that says what a reader gains

The message should name the result sets that changed, because "sync results" tells a future reader nothing about what appeared on the site. The bundled script diffs the staged result sets against the committed ones and prints a summary:

```sh
python3 .claude/skills/publish-results/scripts/summarize.py
```

It prints a subject line and a body with one bullet per `(document, model)` pair, and it distinguishes the kinds of change that look alike in a cell count: cells **added**, cells **re-run** (same count, different answers), costs **re-priced** (same answers, different rate card), and metadata-only stamps. Where an arm's fixed cost moved it says so on its own line, because that number is the y-intercept of the cost chart and a change in it is usually the news.

Use it as written when it fits. Extend the body when you know something it cannot — it describes *what* changed and only you know *why*: a bug in an arm, a rate card that moved, a set withdrawn. Then:

```sh
git commit -F <message-file>
```

A good message looks like:

```
Publish edgar-contract measured with claude-opus-5

  + edgar-contract · claude-opus-5 — 105/105 cells
  ~ arxiv-paper · claude-sonnet-5 — 104 → 105 cells
  - arxiv-paper · claude-haiku-4-5 — superseded
```

Or, for a publish that corrects numbers rather than adding them:

```
Publish cached_context_5m and cached_context_1h re-run across 2 result sets

  ~ arxiv-paper · claude-sonnet-5 — 30 cells re-run in cached_context_5m, cached_context_1h; 105/105 cells
      cached_context_1h fixed cost $0.0000 → $0.1009
  ~ edgar-contract · claude-sonnet-5 — 30 cells re-run in cached_context_5m, cached_context_1h; 105/105 cells
      cached_context_1h fixed cost $0.0000 → $0.2116
```

### 7. Push, which is what deploys

```sh
git push
```

The push triggers the Pages workflow. Two failure modes worth recognising rather than re-diagnosing:

- **"Branch `static-pages` is not allowed to deploy to github-pages due to environment protection rules."** The build succeeded and only the deploy was refused. The `github-pages` environment restricts deployments to the default branch until `static-pages` is added under *Settings → Environments → github-pages → Deployment branches and tags*. That is a repository setting only the owner can change; once it is in, re-running the failed job on the existing run is enough — no new commit.
- **A green workflow but stale content.** Almost always a build that ran before the results landed. Check what the deployed page actually contains rather than trusting the checkmark, which is what the next step is for.

### 8. Verify the deploy by what the page contains

A 200 proves the old site is still there. Confirm the *new* measurement arrived by looking for a fingerprint of it — a model id or document type that only the new result set has:

```sh
curl -s https://olgamaslova.github.io/doc-understanding/ | grep -c "claude-opus-5"
```

Pages usually takes one to three minutes. If you want to wait for it rather than poll by hand, use an until-loop in a background shell so the wait does not block:

```sh
until curl -s https://olgamaslova.github.io/doc-understanding/ | grep -q "claude-opus-5"; do sleep 15; done
```

Derive the URL from the remote (`git remote get-url origin` → `https://<owner>.github.io/<repo>/`) rather than assuming this one. If the remote is not GitHub — a fixture, a local clone, a mirror — there is no deployment to verify, so say so and skip this step instead of waiting on a URL that will never answer.

### 9. Go back where you started

```sh
git checkout <the branch from step 1>
```

Leaving someone on `static-pages` invites the next run's results to be committed to the deploy branch, which is the one direction this repository has no story for.

## Reporting back

Tell the user what is now live, in one or two sentences: which document and model appeared, whether the matrix is complete or partial, and the URL. If the deploy has not landed yet, say what you are waiting on and what you saw. If you skipped the push because nothing changed, say that plainly rather than implying work happened.

## When someone asks for more than measurements

- **"Publish the UI fix too."** That is a code change, so it travels by cherry-pick: `git cherry-pick <sha>` onto `static-pages`, expecting conflicts in the files that deliberately differ. Tell the user that is a separate piece of work and confirm before doing it — a code cherry-pick can silently reintroduce the run flow this branch exists to remove.
- **"Publish only one document."** The manifest describes the whole of `results/`, so a partial publish means a manifest that names files the branch does not have — which fails the build at `scripts/build-replay.mjs`, deliberately. Publish `results/` whole. If a set genuinely should not ship, remove it on `main` first.
- **"Why is the site missing a document that has results?"** Check `results/manifest.json` on `static-pages` rather than on `main`. Almost every "the site is wrong" report is a publish that never happened.
