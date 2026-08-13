#!/usr/bin/env python3
"""Describe a publish, by diffing the manifest that is staged against the one committed.

A commit message saying "sync results" tells a future reader nothing: the question
they will have is which measurement appeared on the site, how complete it was, and
what it replaced. All of that is in results/manifest.json, which records one entry
per (document, model) result set with its cell counts — so the message can be
derived rather than remembered.

Run with results/ and data/docs/ already staged, on the static-pages branch:

    python3 .claude/skills/publish-results/scripts/summarize.py

Prints a commit message on stdout — subject line, blank line, one bullet per
changed result set. Writes nothing and commits nothing; piping it into a file and
editing before committing is the expected use:

    python3 .../summarize.py > /tmp/publish-msg.txt
    git commit -F /tmp/publish-msg.txt

Exits 1 with a note on stderr if nothing changed, so a caller can tell "already
published" apart from "here is your message" without parsing prose.
"""

import json
import subprocess
import sys


MANIFEST = "results/manifest.json"


def read_manifest(ref: str | None) -> dict:
    """The manifest as of `ref`, or as staged when `ref` is None. {} if absent."""
    spec = f"{ref}:{MANIFEST}" if ref else f":{MANIFEST}"
    try:
        raw = subprocess.run(
            ["git", "show", spec],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except subprocess.CalledProcessError:
        # No manifest on that side: either a first publish (nothing committed) or
        # the staged tree has none, which step 5 of the skill will have caught.
        return {}
    return json.loads(raw)


def by_pair(manifest: dict) -> dict[tuple[str, str], dict]:
    return {(d["doc_id"], d["model"]): d for d in manifest.get("docs", [])}


def label(entry: dict) -> str:
    cells, expected = entry.get("cells", 0), entry.get("cells_expected", 0)
    complete = "" if cells == expected else " (partial)"
    return f"{cells}/{expected} cells{complete}"


def main() -> int:
    old = by_pair(read_manifest("HEAD"))
    new = by_pair(read_manifest(None))

    added = [k for k in new if k not in old]
    removed = [k for k in old if k not in new]
    changed = [
        k
        for k in new
        if k in old
        and (
            new[k].get("cells") != old[k].get("cells")
            or new[k].get("computed_at") != old[k].get("computed_at")
        )
    ]

    if not (added or removed or changed):
        print(
            "The staged manifest matches the committed one: these measurements are "
            "already published.",
            file=sys.stderr,
        )
        return 1

    # The subject names what a reader would call the news. One new set is the
    # common case and deserves its name in the subject; more than one gets a count,
    # because a subject line listing four documents is unreadable in a log.
    if len(added) == 1 and not removed:
        doc, model = added[0]
        subject = f"Publish {doc} measured with {model}"
    elif len(added) == 2:
        # Two is still readable in a log, and the document names are the part
        # someone scanning history is looking for.
        subject = "Publish " + " and ".join(sorted(doc for doc, _ in added))
    elif added:
        subject = f"Publish {len(added)} new result sets"
    elif changed and not removed:
        subject = (
            f"Publish more cells for {changed[0][0]}"
            if len(changed) == 1
            else f"Publish more cells for {len(changed)} result sets"
        )
    else:
        subject = "Publish updated measurements"

    lines = [subject, ""]
    for key in sorted(added):
        lines.append(f"  + {key[0]} · {key[1]} — {label(new[key])}")
    for key in sorted(changed):
        was, now = old[key].get("cells", 0), new[key].get("cells", 0)
        detail = f"{was} → {now} cells" if was != now else f"remeasured, {label(new[key])}"
        lines.append(f"  ~ {key[0]} · {key[1]} — {detail}")
    for key in sorted(removed):
        lines.append(f"  - {key[0]} · {key[1]} — removed on main, dropped here")

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
