"""Token-aware fixed-size chunking.

Naive chunk RAG (arm 3) and hybrid retrieval (arm 4) share these chunks so the
only difference between the arms is retrieval quality, not segmentation. The
parameters are documented in the README because arm 4's honesty depends on them
being auditable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CHUNK_TOKENS = 500
OVERLAP_TOKENS = 50

# Rough chars-per-token for the target-size heuristic. Chunk boundaries do not
# need exact token counts — the sizes are validated against count_tokens once
# per document rather than per chunk, which would be thousands of API calls.
CHARS_PER_TOKEN = 3.7

_PARA = re.compile(r"\n\s*\n")
_SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\"'\[])")


@dataclass(frozen=True)
class Chunk:
    index: int
    text: str
    char_start: int
    char_end: int

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "text": self.text,
            "char_start": self.char_start,
            "char_end": self.char_end,
        }


def _units(text: str) -> list[tuple[str, int]]:
    """Split into (unit_text, char_offset) at paragraph then sentence level.

    Splitting on structure first keeps chunks from severing a sentence or table
    row mid-way, which is the cheapest thing you can do for retrieval quality
    without abandoning fixed-size chunking.
    """
    units: list[tuple[str, int]] = []
    pos = 0
    for para in _PARA.split(text):
        start = text.find(para, pos)
        if start == -1:
            start = pos
        pos = start + len(para)
        if not para.strip():
            continue
        target = int(CHUNK_TOKENS * CHARS_PER_TOKEN)
        if len(para) <= target:
            units.append((para, start))
            continue
        inner = start
        for sent in _SENT.split(para):
            s = text.find(sent, inner)
            if s == -1:
                s = inner
            inner = s + len(sent)
            if not sent.strip():
                continue
            # A "sentence" with no punctuation can be arbitrarily long — a wide
            # financial table row, or minified text. Hard-split it so one unit
            # cannot produce a chunk many times the target size.
            if len(sent) > target:
                for off in range(0, len(sent), target):
                    units.append((sent[off : off + target], s + off))
            else:
                units.append((sent, s))
    return units


def chunk_document(text: str) -> list[Chunk]:
    target_chars = int(CHUNK_TOKENS * CHARS_PER_TOKEN)
    overlap_chars = int(OVERLAP_TOKENS * CHARS_PER_TOKEN)

    chunks: list[Chunk] = []
    buf: list[tuple[str, int]] = []
    buf_len = 0

    def flush() -> None:
        nonlocal buf, buf_len
        if not buf:
            return
        body = "\n\n".join(u for u, _ in buf)
        chunks.append(
            Chunk(
                index=len(chunks),
                text=body,
                char_start=buf[0][1],
                char_end=buf[-1][1] + len(buf[-1][0]),
            )
        )
        # Carry the tail of this chunk into the next one so a fact that lands on
        # a boundary is retrievable from either side.
        carried: list[tuple[str, int]] = []
        carried_len = 0
        for unit, off in reversed(buf):
            if carried_len >= overlap_chars:
                break
            carried.insert(0, (unit, off))
            carried_len += len(unit)
        buf = carried
        buf_len = carried_len

    for unit, off in _units(text):
        if buf_len + len(unit) > target_chars and buf:
            flush()
        buf.append((unit, off))
        buf_len += len(unit)
    # Final flush must not re-seed a carry-over, or it loops forever.
    if buf:
        body = "\n\n".join(u for u, _ in buf)
        chunks.append(
            Chunk(
                index=len(chunks),
                text=body,
                char_start=buf[0][1],
                char_end=buf[-1][1] + len(buf[-1][0]),
            )
        )
    return chunks
