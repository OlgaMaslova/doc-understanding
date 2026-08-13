#!/usr/bin/env python3
"""Describe a publish, by diffing the staged result sets against the committed ones.

A commit message saying "sync results" tells a future reader nothing: the question
they will have is which measurement appeared on the site, how complete it was, and
what it replaced. Most of that is in results/manifest.json, which records one entry
per (document, model) result set with its cell counts — so the message can be
derived rather than remembered.

The manifest alone is not enough, though, and reading only it gets publishes wrong
in two ways that have both happened:

  * A re-measurement that holds the cell count steady looked like new cells. Thirty
    cached-context cells were re-run at the same 105/105 and the subject line called
    it "more cells", which is false twice over — none were added, and the values
    that did change went unmentioned.
  * A change with no manifest footprint was invisible. Re-pricing a set rewrites
    every cost in it but touches neither `cells` nor `computed_at`, so a set whose
    spend fell by a third was left out of the message entirely.

So the comparison here is the result files themselves, and a set counts as changed
when its bytes changed. What *kind* of change it was — cells added, cells re-run,
costs re-priced — is then read out of the two files rather than guessed from counts.

Run with results/ and data/docs/ already staged, on either branch:

    python3 .claude/skills/publish-results/scripts/summarize.py
    python3 .claude/skills/publish-results/scripts/summarize.py --verb Record

The default verb suits the publish commit on static-pages. Use `--verb Record` for
the commit that lands a fresh run on main, where nothing is being published yet —
the same diff, described as what it is.

Prints a commit message on stdout — subject line, blank line, one bullet per
changed result set. Writes nothing and commits nothing; piping it into a file and
editing before committing is the expected use:

    python3 .../summarize.py > /tmp/publish-msg.txt
    git commit -F /tmp/publish-msg.txt

It describes what changed, not why. When you know the reason — a bug in an arm, a
rate card that moved, a set withdrawn — that belongs in the body and only you have
it.

Exits 1 with a note on stderr if nothing changed, so a caller can tell "already
published" apart from "here is your message" without parsing prose.
"""

import json
import subprocess
import sys


MANIFEST = "results/manifest.json"

# The fields of a cell that record what the model did. A difference in any of them
# means the cell was re-run; a difference confined to `cost` means it was re-priced
# from the usage it already had. Keeping the two apart is the whole point — one
# spends money and can change an answer, the other cannot.
MEASURED_FIELDS = (
    "answer",
    "grade",
    "usage",
    "latency_ms",
    "ttft_ms",
    "notes",
    "deltas",
    "error",
)


def show(ref: str | None, path: str) -> str | None:
    """`path` as of `ref`, or as staged when `ref` is None. None if absent."""
    spec = f"{ref}:{path}" if ref else f":{path}"
    try:
        return subprocess.run(
            ["git", "show", spec], capture_output=True, text=True, check=True
        ).stdout
    except subprocess.CalledProcessError:
        # Either a first publish (nothing committed) or the staged tree has none,
        # which step 5 of the skill will have caught.
        return None


def read_json(ref: str | None, path: str) -> dict:
    raw = show(ref, path)
    return json.loads(raw) if raw else {}


def by_pair(manifest: dict) -> dict[tuple[str, str], dict]:
    return {(d["doc_id"], d["model"]): d for d in manifest.get("docs", [])}


def label(entry: dict) -> str:
    cells, expected = entry.get("cells", 0), entry.get("cells_expected", 0)
    complete = "" if cells == expected else " (partial)"
    return f"{cells}/{expected} cells{complete}"


def money(value: float) -> str:
    return f"${value:.4f}"


def spend(data: dict) -> float:
    return sum(c["cost"]["total"] for c in data.get("cells", {}).values() if "cost" in c)


def diff_sets(old: dict, new: dict) -> dict:
    """Classify what changed between two result sets.

    Returns cell counts split by kind, the arms the re-run cells belong to, the
    change in total spend, and any arm whose fixed cost moved. The last one matters
    more than its size suggests: an arm's fixed cost is the y-intercept of the cost
    chart, so a warm that went unbilled shows up as a claim that warming is free.
    """
    old_cells, new_cells = old.get("cells", {}), new.get("cells", {})
    remeasured: dict[str, int] = {}
    repriced = 0

    for key in set(old_cells) & set(new_cells):
        o, n = old_cells[key], new_cells[key]
        if any(o.get(f) != n.get(f) for f in MEASURED_FIELDS):
            arm = n.get("arm") or key.split("::")[0]
            remeasured[arm] = remeasured.get(arm, 0) + 1
        elif o.get("cost") != n.get("cost"):
            repriced += 1

    fixed: dict[str, tuple[float, float]] = {}
    for arm, entry in new.get("economics", {}).items():
        was = (old.get("economics", {}).get(arm) or {}).get("fixed_cost_usd")
        now = entry.get("fixed_cost_usd")
        if was is not None and now is not None and abs(now - was) >= 5e-5:
            fixed[arm] = (was, now)

    return {
        "added": sorted(set(new_cells) - set(old_cells)),
        "dropped": sorted(set(old_cells) - set(new_cells)),
        "remeasured": remeasured,
        "repriced": repriced,
        "spend": (spend(old), spend(new)),
        "fixed": fixed,
        # Arm order comes from the file rather than a constant, because economics is
        # written in ARM_ORDER and JSON preserves insertion order.
        "arm_order": list(new.get("economics", {})),
    }


def arms_phrase(diff: dict) -> str:
    order = diff["arm_order"]
    arms = sorted(diff["remeasured"], key=lambda a: order.index(a) if a in order else 99)
    return ", ".join(arms)


def describe(entry_old: dict, entry_new: dict, diff: dict) -> list[str]:
    """The bullet for one changed set, plus any indented detail lines under it."""
    was, now = entry_old.get("cells", 0), entry_new.get("cells", 0)
    total = sum(diff["remeasured"].values())

    if was != now:
        head = f"{was} → {now} cells"
    elif total:
        head = f"{total} cells re-run in {arms_phrase(diff)}; {label(entry_new)}"
    elif diff["repriced"]:
        head = f"re-priced, {label(entry_new)} unchanged"
    elif not diff["added"] and not diff["dropped"]:
        # The file moved but no cell and no cost did — a re-stamped snapshot date is
        # the usual cause. Saying so beats "updated", which invites the reader to go
        # looking for a change that is not there.
        head = f"metadata only; {label(entry_new)}, measurements and costs unchanged"
    else:
        head = f"updated, {label(entry_new)}"

    lines = [head]
    if diff["repriced"] and (was != now or total):
        lines.append(f"{diff['repriced']} cells re-priced")
    old_spend, new_spend = diff["spend"]
    if abs(new_spend - old_spend) >= 5e-5:
        lines.append(f"spend {money(old_spend)} → {money(new_spend)}")
    for arm, (a, b) in diff["fixed"].items():
        lines.append(f"{arm} fixed cost {money(a)} → {money(b)}")
    return lines


def subject_for(verb: str, added, removed, changed, entries_old, entries_new, diffs):
    """The subject names what a reader would call the news."""
    # One new set is the common case and deserves its name; more than one gets a
    # count, because a subject line listing four documents is unreadable in a log.
    if len(added) == 1 and not removed:
        doc, model = added[0]
        return f"{verb} {doc} measured with {model}"
    if len(added) == 2:
        # Two is still readable, and the document names are the part someone
        # scanning history is looking for.
        return f"{verb} " + " and ".join(sorted(doc for doc, _ in added))
    if added:
        return f"{verb} {len(added)} new result sets"
    if removed and not changed:
        if len(removed) == 1:
            doc, model = removed[0]
            return f"{verb} the removal of {doc} · {model}"
        return f"{verb} the removal of {len(removed)} result sets"

    if changed:
        completed = [
            k
            for k in changed
            if entries_new[k].get("cells") == entries_new[k].get("cells_expected")
            and entries_old[k].get("cells") != entries_old[k].get("cells_expected")
        ]
        extended = [k for k in changed if entries_old[k].get("cells") != entries_new[k].get("cells")]
        rerun = [k for k in changed if diffs[k]["remeasured"]]
        repriced = [k for k in changed if diffs[k]["repriced"] and not diffs[k]["remeasured"]]

        # A set that filled in is the news even when other sets moved alongside it,
        # so this outranks the rest: "104 → 105, now complete" is what the reader
        # should not have to open the manifest to find.
        if len(completed) == 1:
            doc, model = completed[0]
            return f"{verb} the completed matrix for {doc} · {model}"
        if completed:
            return f"{verb} {len(completed)} completed matrices"
        if extended:
            if len(extended) == 1:
                return f"{verb} more cells for {extended[0][0]}"
            return f"{verb} more cells for {len(extended)} result sets"
        if rerun:
            # Say what was re-run, not just that something was. When every re-run
            # cell across the publish sits in the same one or two arms, those arms
            # are the news and they fit.
            arms = {a for k in rerun for a in diffs[k]["remeasured"]}
            cells = sum(sum(diffs[k]["remeasured"].values()) for k in rerun)
            if len(arms) <= 2:
                order = diffs[rerun[0]]["arm_order"]
                where = " and ".join(
                    sorted(arms, key=lambda a: order.index(a) if a in order else 99)
                )
                if len(rerun) == 1:
                    return f"{verb} {where} re-run for {rerun[0][0]}"
                return f"{verb} {where} re-run across {len(rerun)} result sets"
            if len(rerun) == 1:
                return f"{verb} {cells} re-run cells for {rerun[0][0]}"
            return f"{verb} {cells} re-run cells across {len(rerun)} result sets"
        if repriced and len(repriced) == len(changed):
            if len(changed) == 1:
                return f"{verb} re-priced costs for {changed[0][0]}"
            return f"{verb} re-priced costs for {len(changed)} result sets"

    return f"{verb} updated measurements"


def main() -> int:
    verb = "Publish"
    args = sys.argv[1:]
    if args[:1] == ["--verb"] and len(args) > 1:
        verb = args[1]

    old_manifest, new_manifest = read_json("HEAD", MANIFEST), read_json(None, MANIFEST)
    old, new = by_pair(old_manifest), by_pair(new_manifest)

    added = [k for k in new if k not in old]
    removed = [k for k in old if k not in new]

    # A set counts as changed when its file changed, not when its manifest entry
    # did: re-pricing rewrites every cost while leaving `cells` and `computed_at`
    # exactly as they were.
    changed, diffs = [], {}
    for key in [k for k in new if k in old]:
        old_path = f"results/{old[key]['file']}"
        new_path = f"results/{new[key]['file']}"
        old_raw, new_raw = show("HEAD", old_path), show(None, new_path)
        if old_raw is None or new_raw is None or old_raw == new_raw:
            continue
        changed.append(key)
        diffs[key] = diff_sets(json.loads(old_raw), json.loads(new_raw))

    if not (added or removed or changed):
        print(
            "The staged result sets match the committed ones: nothing new here.",
            file=sys.stderr,
        )
        return 1

    lines = [subject_for(verb, added, removed, changed, old, new, diffs), ""]

    was_rate = old_manifest.get("pricing_snapshot")
    now_rate = new_manifest.get("pricing_snapshot")
    if was_rate and now_rate and was_rate != now_rate:
        lines.append(f"  Rate card {was_rate} → {now_rate}.")
        lines.append("")

    for key in sorted(added):
        lines.append(f"  + {key[0]} · {key[1]} — {label(new[key])}")
    for key in sorted(changed):
        detail = describe(old[key], new[key], diffs[key])
        lines.append(f"  ~ {key[0]} · {key[1]} — {detail[0]}")
        lines.extend(f"      {line}" for line in detail[1:])
    for key in sorted(removed):
        lines.append(f"  - {key[0]} · {key[1]} — removed on main, dropped here")

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
