#!/usr/bin/env python3
"""Extract PDF text with page numbers, in reading order (two-column aware).

Usage: extract_text.py paper.pdf out.txt

Writes "=== PAGE n (label L) ===" headers. Full-width blocks (title, wide
figures, captions) split the page into bands. Inside each band the left column
is written first, then the right column.
"""
import sys

import pymupdf


def page_blocks(page):
    width = page.rect.width
    mid = width / 2
    blocks = [b for b in page.get_text("blocks") if b[6] == 0 and b[4].strip()]
    wide = [b for b in blocks if (b[2] - b[0]) > 0.6 * width]
    narrow = [b for b in blocks if b not in wide]
    # band edges are the y positions of the wide blocks
    wide.sort(key=lambda b: b[1])
    out, cursor = [], -1.0

    def flush(lo, hi):
        band = [b for b in narrow if lo <= b[1] < hi]
        left = sorted([b for b in band if (b[0] + b[2]) / 2 < mid], key=lambda b: b[1])
        right = sorted([b for b in band if (b[0] + b[2]) / 2 >= mid], key=lambda b: b[1])
        return left + right

    for w in wide:
        out += flush(cursor, w[1])
        out.append(w)
        cursor = w[1]
    out += flush(cursor, 1e9)
    seen, uniq = set(), []
    for b in out:
        k = (round(b[0]), round(b[1]), b[4][:20])
        if k not in seen:
            seen.add(k)
            uniq.append(b)
    return uniq


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: extract_text.py paper.pdf out.txt")
    doc = pymupdf.open(sys.argv[1])
    out = []
    for i, page in enumerate(doc):
        label = page.get_label() or str(i + 1)
        out.append(f"=== PAGE {i + 1} (label {label}) ===")
        for b in page_blocks(page):
            out.append(" ".join(b[4].split()))
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print(f"{len(doc)} pages -> {sys.argv[2]}")


if __name__ == "__main__":
    main()
