"""The three source documents: fetch, normalize, commit.

Sources are chosen so token counts span more than an order of magnitude —
document size is what moves the cost crossover, so the spread is the point.
Everything here is redistributable: CC-BY arXiv and SEC public filings.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from typing import Iterable

import httpx

from .paths import DOCS

# SEC asks for a descriptive User-Agent on programmatic access.
SEC_HEADERS = {
    "User-Agent": "DocRace research demo (contact: olga@supernaut.dev)",
    "Accept-Encoding": "gzip, deflate",
}


@dataclass(frozen=True)
class SourceDoc:
    doc_id: str
    domain: str
    title: str
    url: str
    provenance: str
    license: str

    @property
    def text_path(self):
        return DOCS / f"{self.doc_id}.txt"

    @property
    def meta_path(self):
        return DOCS / f"{self.doc_id}.json"


SOURCES: tuple[SourceDoc, ...] = (
    SourceDoc(
        doc_id="arxiv-paper",
        domain="scientific",
        title="Mamba: Linear-Time Sequence Modeling with Selective State Spaces",
        # The /html/ rendering, not /abs/ — the abstract page is a landing page.
        # v1 has no HTML build; v2 does.
        url="https://arxiv.org/html/2312.00752v2",
        provenance="arXiv:2312.00752v2 (Gu and Dao, 2023)",
        license="CC BY 4.0 (verified on the arXiv abstract page)",
    ),
    # Chosen because it is unredacted. Almost every post-2019 pharma license
    # exhibit blanks its economics under Reg S-K 601(b)(10)(iv), and a contract
    # with [***] where the milestone payments should be cannot support an
    # aggregation question about payment terms.
    SourceDoc(
        doc_id="edgar-contract",
        domain="legal",
        title=(
            "License Agreement between Processa Pharmaceuticals and Ocuphire Pharma"
        ),
        url=(
            "https://www.sec.gov/Archives/edgar/data/1228627/"
            "000114036121022033/brhc10026111_ex10-1.htm"
        ),
        provenance=(
            "SEC EDGAR — Ocuphire Pharma, Inc. (CIK 0001228627), Form 8-K "
            "filed 2021-06-23, Exhibit 10.1"
        ),
        license="U.S. public filing (public record)",
    ),
    SourceDoc(
        doc_id="form-10k",
        domain="financial",
        title="Ford Motor Company — Annual Report on Form 10-K, FY2025",
        url=(
            "https://www.sec.gov/Archives/edgar/data/37996/"
            "000003799626000015/f-20251231.htm"
        ),
        provenance=(
            "SEC EDGAR — Ford Motor Company (CIK 0000037996), Form 10-K for the "
            "fiscal year ended 2025-12-31, filed 2026-02-11"
        ),
        license="U.S. public filing (public record)",
    ),
)

BY_ID = {s.doc_id: s for s in SOURCES}


_SCRIPT_STYLE = re.compile(
    r"<(script|style|head)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL
)
# Inline-XBRL filings open with an ix:header carrying every context reference in
# the document — on a 10-K that is ~110k characters of machine tagging like
# "0000037996 us-gaap:CommonStockMember 2025-01-01" before a word of prose. Left
# in, it would inflate the token count by more than half and give every arm the
# same wall of noise to wade through first.
_IX_HEADER = re.compile(r"<ix:header\b.*?</ix:header\s*>", re.IGNORECASE | re.DOTALL)
_IX_HIDDEN = re.compile(r"<ix:hidden\b.*?</ix:hidden\s*>", re.IGNORECASE | re.DOTALL)
# arXiv's HTML wraps every formula in MathML that carries both rendered glyphs
# and an <annotation> holding the original LaTeX. Keeping both turns "x_t" into
# "xtx_{t}", which is noise in the prompt and poison for BM25.
_MATH_ANNOTATION = re.compile(
    r"<annotation(-xml)?\b[^>]*>.*?</annotation(-xml)?>", re.IGNORECASE | re.DOTALL
)
_BLOCK_END = re.compile(
    r"</(p|div|tr|li|h[1-6]|table|section|blockquote)\s*>", re.IGNORECASE
)
_BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")
_CELL_END = re.compile(r"</(td|th)\s*>", re.IGNORECASE)

# Real filings nest tables inside tables for layout, so any attempt to flatten a
# cell with a non-greedy regex terminates on an inner cell's close tag and
# silently mangles the rest of the row. Cells are simply tab-separated and long
# lines are wrapped afterwards instead. Table structure survives imperfectly —
# which is what a regex stripper over 10-K HTML gets you — but every arm reads
# the same text, so the comparison stays fair.
WRAP_TRIGGER = 400
WRAP_WIDTH = 180
_MANY_BLANKS = re.compile(r"\n{3,}")
_TRAILING_SPACE = re.compile(r"[ \t]+\n")
_MANY_SPACES = re.compile(r"[ \t]{2,}")


def _wrap_long_lines(text: str) -> str:
    """Wrap lines past WRAP_TRIGGER at WRAP_WIDTH on whitespace.

    Stripping a 10-K's layout markup leaves a few lines over a hundred thousand
    characters long. That breaks the agentic arm specifically: a `grep` hit is
    only useful if the line it returns is readable, and `read_lines` needs lines
    to be a meaningful unit of navigation.
    """
    out: list[str] = []
    for line in text.split("\n"):
        if len(line) <= WRAP_TRIGGER:
            out.append(line)
            continue
        current = ""
        for word in line.split(" "):
            if current and len(current) + 1 + len(word) > WRAP_WIDTH:
                out.append(current)
                current = word
            else:
                current = f"{current} {word}" if current else word
        if current:
            out.append(current)
    return "\n".join(out)


def html_to_text(raw: str) -> str:
    """Strip HTML to readable plain text, preserving block and table structure.

    Table cells become tab-separated so a 10-K's financial tables survive as
    something a model can still read row-wise.
    """
    s = _IX_HEADER.sub(" ", raw)
    s = _IX_HIDDEN.sub(" ", s)
    s = _SCRIPT_STYLE.sub(" ", s)
    s = _MATH_ANNOTATION.sub(" ", s)
    s = _BR.sub("\n", s)
    s = _CELL_END.sub("\t", s)
    s = _BLOCK_END.sub("\n", s)
    s = _TAG.sub("", s)
    s = html.unescape(s)
    s = s.replace("\xa0", " ").replace("​", "")
    s = _MANY_SPACES.sub(" ", s)
    s = _TRAILING_SPACE.sub("\n", s)
    s = _MANY_BLANKS.sub("\n\n", s)
    return _wrap_long_lines(s.strip())


def fetch(url: str, *, sec: bool = False) -> str:
    headers = SEC_HEADERS if sec else {"User-Agent": SEC_HEADERS["User-Agent"]}
    with httpx.Client(follow_redirects=True, timeout=60.0, headers=headers) as c:
        r = c.get(url)
        r.raise_for_status()
        return r.text


def load_text(doc_id: str) -> str:
    path = BY_ID[doc_id].text_path
    if not path.exists():
        raise FileNotFoundError(
            f"{path} is missing — run `python -m docrace.documents fetch` first"
        )
    return path.read_text()


def load_meta(doc_id: str) -> dict:
    path = BY_ID[doc_id].meta_path
    if not path.exists():
        # The text is committed but the metadata is not: it carries an API-counted
        # token count, which is the x-axis of the whole argument, so it cannot be
        # produced without a key. A bare FileNotFoundError three frames into a paid
        # run is a bad way to learn that.
        raise SystemExit(
            f"No metadata for {doc_id} at {path}.\n"
            f"The document text is committed; its token count is not, because "
            f"counting needs an API key.\n"
            f"Run:  python -m docrace.documents --meta-only\n"
            f"That counts tokens on the committed text without re-fetching, and "
            f"token counting is free."
        )
    return json.loads(path.read_text())


def all_doc_ids() -> Iterable[str]:
    """Doc IDs in ascending token order, so charts and CLI output read small→large."""
    metas = [(load_meta(s.doc_id)["tokens"], s.doc_id) for s in SOURCES]
    return [doc_id for _, doc_id in sorted(metas)]


def fetch_and_normalize(source: SourceDoc, *, sec: bool) -> dict:
    """Fetch, strip to text, count tokens, and commit both text and metadata.

    Token counts come from the API rather than an estimate: they are
    model-specific, they are the x-axis of the whole argument, and a third-party
    tokenizer would be wrong by 15-20% on prose and worse on tables.
    """
    from .client import count_tokens  # imported here so fetching needs no key

    if not source.url:
        raise ValueError(
            f"{source.doc_id} has no URL yet — fill it in in documents.py SOURCES"
        )

    raw = fetch(source.url, sec=sec)
    text = html_to_text(raw) if "<" in raw[:2000] else raw.strip()
    DOCS.mkdir(parents=True, exist_ok=True)
    source.text_path.write_text(text)

    tokens = count_tokens(text)
    meta = {
        "doc_id": source.doc_id,
        "domain": source.domain,
        "title": source.title,
        "url": source.url,
        "provenance": source.provenance,
        "license": source.license,
        "tokens": tokens,
        "chars": len(text),
        "lines": text.count("\n") + 1,
    }
    source.meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def write_meta(source: SourceDoc) -> dict:
    """Count tokens on the already-committed text and write the metadata.

    Separate from fetching so metadata can be rebuilt without re-downloading —
    which matters because a re-fetch could normalize differently than the text the
    question set's quotes were verified against, silently invalidating the answer
    key. Token counting is free.
    """
    from .client import count_tokens

    if not source.text_path.exists():
        raise SystemExit(
            f"{source.doc_id}: no text at {source.text_path}. "
            f"Fetch it first with `python -m docrace.documents`."
        )
    text = source.text_path.read_text()
    meta = {
        "doc_id": source.doc_id,
        "domain": source.domain,
        "title": source.title,
        "url": source.url,
        "provenance": source.provenance,
        "license": source.license,
        "tokens": count_tokens(text),
        "chars": len(text),
        "lines": text.count("\n") + 1,
    }
    source.meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Fetch and normalize the source documents.")
    ap.add_argument("--doc", action="append", help="Doc id; repeatable. Default: all.")
    ap.add_argument(
        "--meta-only",
        action="store_true",
        help=(
            "Skip fetching; count tokens on the committed text and write metadata. "
            "Use this when the text is present but the token counts are missing."
        ),
    )
    args = ap.parse_args()

    for doc_id in args.doc or list(BY_ID):
        source = BY_ID[doc_id]
        if args.meta_only:
            meta = write_meta(source)
        else:
            meta = fetch_and_normalize(source, sec="sec.gov" in source.url)
        print(
            f"{doc_id}: {meta['tokens']:,} tokens, {meta['chars']:,} chars, "
            f"{meta['lines']:,} lines"
        )


if __name__ == "__main__":
    main()
