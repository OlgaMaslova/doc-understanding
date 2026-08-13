#!/usr/bin/env python3
"""Grade a publish-results test run by inspecting the fixture repo it left behind.

Every assertion is a git question with a yes/no answer, so grading is a script rather
than a judgement call.

    python3 grade.py <workspace-dir>

The workspace holds four fixtures built by make-fixture.sh — fixture-a and -b for the
`publish` scenario (with and without the skill), fixture-c and -d for `nothing` — and
gets one grading.json plus a readable end-state.md per run written back into it.
"""

import json
import subprocess
import sys
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit(__doc__)
ROOT = Path(sys.argv[1]).resolve()

RUNS = [
    ("eval-publish-new-measurement", "with_skill", "fixture-a"),
    ("eval-publish-new-measurement", "without_skill", "fixture-b"),
    ("eval-already-published", "with_skill", "fixture-c"),
    ("eval-already-published", "without_skill", "fixture-d"),
]


def git(repo, *args, ok_fail=False):
    r = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True
    )
    if r.returncode and not ok_fail:
        return ""
    return r.stdout.strip()


def files_on(repo, ref):
    out = git(repo, "ls-tree", "-r", "--name-only", ref, "--", "results", "data/docs")
    return set(out.splitlines())


def grade_publish(repo):
    sp = files_on(repo, "static-pages")
    head_msg = git(repo, "log", "-1", "--format=%B", "static-pages")
    committed_paths = git(
        repo, "show", "--stat=200", "--name-only", "--format=", "static-pages"
    ).splitlines()
    committed_paths = [p for p in committed_paths if p.strip()]
    readme = git(repo, "show", "static-pages:README.md")
    page = git(repo, "show", "static-pages:web/app/page.tsx")
    local = git(repo, "rev-parse", "static-pages")
    remote = git(repo, "rev-parse", "origin/static-pages")
    merges = git(repo, "log", "--merges", "--oneline", "static-pages")
    main_head = git(repo, "rev-parse", "main")
    main_is_ancestor = (
        subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor", main_head, "static-pages"],
            capture_output=True,
        ).returncode
        == 0
    )
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    dirty = git(repo, "status", "--porcelain")

    return [
        {
            "text": "New result sets are on static-pages (edgar-contract.claude-opus-5, form-10k.claude-sonnet-5)",
            "passed": "results/edgar-contract.claude-opus-5.json" in sp
            and "results/form-10k.claude-sonnet-5.json" in sp,
            "evidence": f"results/ on static-pages: {sorted(p for p in sp if p.startswith('results/'))}",
        },
        {
            "text": "New document metadata came along (data/docs/form-10k.json)",
            "passed": "data/docs/form-10k.json" in sp,
            "evidence": f"data/docs on static-pages: {sorted(p for p in sp if p.startswith('data/docs'))}",
        },
        {
            "text": "Superseded result set deleted on main was removed here too (arxiv-paper.claude-haiku-4-5)",
            "passed": "results/arxiv-paper.claude-haiku-4-5.json" not in sp,
            "evidence": (
                "still present"
                if "results/arxiv-paper.claude-haiku-4-5.json" in sp
                else "absent, as on main"
            ),
        },
        {
            "text": "Static-branch code was not overwritten with main's version",
            "passed": "static build" in readme and "ComparisonView" in page,
            "evidence": f"README: {readme[:40]!r}; page.tsx: {page[:60]!r}",
        },
        {
            "text": "Only results/ and data/docs/ were committed",
            "passed": bool(committed_paths)
            and all(
                p.startswith("results/") or p.startswith("data/docs/")
                for p in committed_paths
            ),
            "evidence": f"paths in HEAD commit: {committed_paths}",
        },
        {
            "text": "No merge of main into static-pages",
            "passed": not merges and not main_is_ancestor,
            "evidence": f"merge commits: {merges or 'none'}; main is ancestor of static-pages: {main_is_ancestor}",
        },
        {
            "text": "Commit message names the document and model published",
            "passed": "edgar-contract" in head_msg and "opus" in head_msg,
            "evidence": f"subject: {head_msg.splitlines()[0] if head_msg else '(none)'!r}",
        },
        {
            "text": "Pushed: origin/static-pages matches the local branch",
            "passed": bool(local) and local == remote,
            "evidence": f"local {local[:8]} vs origin {remote[:8]}",
        },
        {
            "text": "Working tree left on the branch it started on (main), and clean",
            "passed": branch == "main" and not dirty,
            "evidence": f"on {branch}, dirty: {dirty or 'no'}",
        },
    ]


def grade_noop(repo):
    # The fixture's static-pages tip before the run is the "Static build" commit.
    original = git(repo, "rev-list", "-1", "--grep=Static build", "static-pages")
    local = git(repo, "rev-parse", "static-pages")
    remote = git(repo, "rev-parse", "origin/static-pages")
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    dirty = git(repo, "status", "--porcelain")
    # Only what happened *after* the fixture built the branch — its own setup commit
    # is not something the run did, and counting it made this assertion fail for
    # every configuration, which is worse than useless.
    reflog = "\n".join(
        line
        for line in git(repo, "reflog", "show", "static-pages", "--format=%gs").splitlines()
        if "Static build" not in line and "Created from HEAD" not in line
    )
    return [
        {
            "text": "No commit was created: static-pages is still at its original tip",
            "passed": bool(original) and local == original,
            "evidence": f"tip {local[:8]}, original {original[:8]}",
        },
        {
            "text": "Nothing was pushed: origin/static-pages unchanged",
            "passed": remote == original,
            "evidence": f"origin {remote[:8]}, original {original[:8]}",
        },
        {
            "text": "No empty commit and no reset gymnastics in the reflog",
            "passed": "commit" not in reflog,
            "evidence": f"reflog: {reflog.splitlines()[:4]}",
        },
        {
            "text": "Working tree left on the branch it started on (main), and clean",
            "passed": branch == "main" and not dirty,
            "evidence": f"on {branch}, dirty: {dirty or 'no'}",
        },
    ]


def main():
    summary = []
    for eval_name, config, fixture in RUNS:
        repo = ROOT / fixture / "repo"
        if not repo.exists():
            print(f"missing fixture: {repo}", file=sys.stderr)
            continue
        checks = (
            grade_publish(repo)
            if eval_name == "eval-publish-new-measurement"
            else grade_noop(repo)
        )
        out = ROOT / eval_name / config
        (out / "outputs").mkdir(parents=True, exist_ok=True)

        # What the run left behind, as a readable artifact for the viewer.
        state = [
            f"# End state — {eval_name} / {config}",
            "",
            "## static-pages log",
            "```",
            git(repo, "log", "--oneline", "--decorate", "-4", "static-pages"),
            "```",
            "## HEAD commit on static-pages",
            "```",
            git(repo, "show", "--stat", "--format=%B", "static-pages"),
            "```",
            "## results/ and data/docs on static-pages",
            "```",
            "\n".join(sorted(files_on(repo, "static-pages"))),
            "```",
            "## git status",
            "```",
            f"on branch {git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')}",
            git(repo, "status", "--porcelain") or "(clean)",
            "```",
        ]
        (out / "outputs" / "end-state.md").write_text("\n".join(state))

        passed = sum(1 for c in checks if c["passed"])
        (out / "grading.json").write_text(
            json.dumps(
                {
                    "eval_id": eval_name,
                    "configuration": config,
                    "expectations": checks,
                    "score": f"{passed}/{len(checks)}",
                },
                indent=2,
            )
        )
        summary.append((eval_name, config, passed, len(checks), checks))

    for eval_name, config, passed, total, checks in summary:
        print(f"\n{eval_name} / {config}: {passed}/{total}")
        for c in checks:
            print(f"  {'PASS' if c['passed'] else 'FAIL'}  {c['text']}")
            if not c["passed"]:
                print(f"        {c['evidence']}")


if __name__ == "__main__":
    main()
