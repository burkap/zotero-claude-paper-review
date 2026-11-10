#!/usr/bin/env python3
"""Find evidence quotes in a PDF and write Zotero annotation JSON.

Usage:
  locate_quotes.py paper.pdf evidence.json annotations.json [--profile profile.yaml]

evidence.json:
  {"evidence": [{"tag": "W2", "type": "weakness", "page": 7, "section": "4.4",
                 "quote": "short word-for-word quote", "comment": "text"}]}
  "page" is the 1-based PDF page (the number in the "=== PAGE n" headers). It is a
  hint: if the quote is not on that page, other pages are searched.
  "type" is one of: claim, strength, weakness, question.

Output (annotations.json): {"annotations": [ {...}, ... ]}. Each entry has the
Zotero fields annotationType, annotationText, annotationComment, annotationColor,
annotationPageLabel, annotationSortIndex, annotationPosition, and the extras
tag, section, evidenceType, pageNumber (the plugin ignores extras).

Rects are in PDF user space, origin at the BOTTOM-left: [x1, y1, x2, y2] with
y1 < y2. PyMuPDF uses a top-left origin, so every rect is converted back with the
inverse of the page transformation matrix (this also handles crop box and rotation).

Matching works on normalised text (NFKC, lower case, letters and digits only) built
from the PDF words in reading order. That ignores line breaks, hyphenation at line
ends, ligatures and spacing. Words are taken in content-stream order first, then
in column-aware block order, so quotes that cross a line break or a column break
are found. A quote that is not found, or is too long, makes the script exit with
code 2 and write no output file. Positions are never guessed.
"""
import difflib
import json
import sys
import unicodedata

import pymupdf

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
try:
    from profile_loader import load_profile
except ImportError:  # PyYAML missing: profile colors fall back to the defaults below
    load_profile = None

DEFAULT_COLORS = {
    "claim": "#ffd400",
    "strength": "#5fb236",
    "weakness": "#ff6666",
    "question": "#2ea8e5",
}
MAX_QUOTE_WORDS = 14  # "under 15 words"
MIN_QUOTE_CHARS = 12


def norm(text):
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(c for c in text if c.isalnum())


def block_order(page):
    """Column-aware block order. Same idea as extract_text.py."""
    width = page.rect.width
    mid = width / 2
    blocks = [b for b in page.get_text("blocks") if b[6] == 0]
    wide = sorted([b for b in blocks if (b[2] - b[0]) > 0.6 * width], key=lambda b: b[1])
    narrow = [b for b in blocks if b not in wide]
    order, cursor = [], -1.0

    def band(lo, hi):
        part = [b for b in narrow if lo <= b[1] < hi]
        left = sorted([b for b in part if (b[0] + b[2]) / 2 < mid], key=lambda b: b[1])
        right = sorted([b for b in part if (b[0] + b[2]) / 2 >= mid], key=lambda b: b[1])
        return left + right

    for w in wide:
        order += band(cursor, w[1])
        order.append(w)
        cursor = w[1]
    order += band(cursor, 1e9)
    return [b[5] for b in order]


def page_streams(page):
    """Yield word lists (one per ordering strategy) for a page."""
    words = page.get_text("words")  # (x0,y0,x1,y1,word,block,line,wordno)
    yield words
    rank = {n: i for i, n in enumerate(block_order(page))}
    yield sorted(words, key=lambda w: (rank.get(w[5], 10**6), w[6], w[7]))


def build_index(words):
    """Return (normalised string, list mapping each char to a word index)."""
    chars, owner = [], []
    for i, w in enumerate(words):
        n = norm(w[4])
        chars.append(n)
        owner.extend([i] * len(n))
    return "".join(chars), owner


def find_all(hay, needle):
    start, hits = 0, []
    while True:
        j = hay.find(needle, start)
        if j < 0:
            return hits
        hits.append(j)
        start = j + 1


def words_text(words):
    out = ""
    for w in words:
        t = w[4]
        if out.endswith("-") and out[-2:-1].isalpha() and t[:1].islower():
            out = out[:-1] + t
        else:
            out += (" " if out else "") + t
    return out


def line_rects(words):
    """Union the matched words into one rect per text line (PyMuPDF space)."""
    lines = {}
    order = []
    for w in words:
        k = (w[5], w[6])
        if k not in lines:
            lines[k] = pymupdf.Rect(w[:4])
            order.append(k)
        else:
            lines[k] |= pymupdf.Rect(w[:4])
    return [lines[k] for k in order]


def to_pdf_space(page, rect):
    m = ~(page.transformation_matrix * page.rotation_matrix)
    r = pymupdf.Rect(rect) * m
    r.normalize()
    return [round(r.x0, 3), round(r.y0, 3), round(r.x1, 3), round(r.y1, 3)]


def locate(doc, quote, page_hint, cache):
    """Return dict with page index, matched words. Raise LookupError if absent."""
    nq = norm(quote)
    if len(nq) < MIN_QUOTE_CHARS:
        raise LookupError(f"quote too short to be unique ({len(nq)} letters/digits)")
    pages = list(range(len(doc)))
    if page_hint and 1 <= page_hint <= len(doc):
        pages.remove(page_hint - 1)
        pages.insert(0, page_hint - 1)
    candidates = []
    for pi in pages:
        if pi not in cache:
            cache[pi] = [build_index(ws) + (ws,) for ws in page_streams(doc[pi])]
        for hay, owner, ws in cache[pi]:
            hits = find_all(hay, nq)
            if hits:
                j = hits[0]
                first, last = owner[j], owner[j + len(nq) - 1]
                candidates.append((pi, ws[first:last + 1], len(hits), first))
                break  # first strategy that matches is enough for this page
        if candidates and pi == (page_hint - 1 if page_hint else -1):
            break  # found on the hinted page
    if not candidates:
        raise LookupError("not found")
    pi, ws, nhits, first = candidates[0]
    return {"pageIndex": pi, "words": ws, "ambiguous": nhits > 1 or len(candidates) > 1,
            "firstWord": first}


def nearest(doc, quote):
    """Closest text in the document, for the error message only."""
    nq = norm(quote)
    best, best_ratio = None, 0.0
    for pi, page in enumerate(doc):
        text = page.get_text("text")
        flat = " ".join(text.split())
        step = max(1, len(quote) // 2)
        for s in range(0, max(1, len(flat) - len(quote)), step):
            chunk = flat[s:s + len(quote) + 10]
            r = difflib.SequenceMatcher(None, norm(chunk), nq).ratio()
            if r > best_ratio:
                best, best_ratio = (pi + 1, chunk), r
    return best, best_ratio


def load_colors(profile_path):
    colors = dict(DEFAULT_COLORS)
    if profile_path:
        if load_profile is None:
            sys.exit("PyYAML is needed to read --profile (pip install pyyaml)")
        prof = load_profile(profile_path)
        for k, v in (prof.get("colors") or {}).items():
            colors[k] = v["hex"] if isinstance(v, dict) else v
    return colors


def sort_index(page, pdf_rects, word_offset):
    height = page.mediabox.height
    top = max(0, int(height - max(r[3] for r in pdf_rects)))
    return f"{page.number:05d}|{max(0, word_offset):06d}|{top:05d}"


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    profile = None
    if "--profile" in argv:
        profile = argv[argv.index("--profile") + 1]
        args.remove(profile)
    if len(args) != 3:
        sys.exit(__doc__)
    pdf_path, ev_path, out_path = args
    colors = load_colors(profile)
    doc = pymupdf.open(pdf_path)
    with open(ev_path, encoding="utf-8") as f:
        evidence = json.load(f)["evidence"]

    cache, annotations, failures, seen_tags = {}, [], [], set()
    for ev in evidence:
        tag = ev.get("tag", "?")
        try:
            if tag in seen_tags:
                raise LookupError("duplicate tag")
            seen_tags.add(tag)
            etype = ev.get("type")
            if etype not in colors:
                raise LookupError(f"unknown type '{etype}' (use {', '.join(colors)})")
            quote = ev.get("quote", "")
            if len(quote.split()) > MAX_QUOTE_WORDS:
                raise LookupError(f"quote has {len(quote.split())} words; limit is {MAX_QUOTE_WORDS}")
            hit = locate(doc, quote, ev.get("page"), cache)
        except LookupError as e:
            info = {"tag": tag, "page": ev.get("page"), "quote": ev.get("quote"), "reason": str(e)}
            if str(e) == "not found":
                near, ratio = nearest(doc, ev.get("quote", ""))
                if near and ratio > 0.5:
                    info["nearest_text"] = f"p.{near[0]}: {near[1]}"
            failures.append(info)
            continue
        page = doc[hit["pageIndex"]]
        rects = [to_pdf_space(page, r) for r in line_rects(hit["words"])]
        label = page.get_label() or str(page.number + 1)
        annotations.append({
            "tag": tag,
            "evidenceType": ev["type"],
            "section": ev.get("section", ""),
            "pageNumber": page.number + 1,
            "ambiguous": hit["ambiguous"],
            "annotationType": "highlight",
            "annotationText": words_text(hit["words"]),
            "annotationComment": f"[{tag}] {ev.get('comment', '').strip()}".strip(),
            "annotationColor": colors[ev["type"]],
            "annotationPageLabel": label,
            "annotationSortIndex": sort_index(page, rects, hit["firstWord"]),
            "annotationPosition": {"pageIndex": page.number, "rects": rects},
        })

    if failures:
        print(f"FAILED: {len(failures)} of {len(evidence)} quotes were not placed. No output written.",
              file=sys.stderr)
        for f_ in failures:
            print(json.dumps(f_, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"annotations": annotations}, f, ensure_ascii=False, indent=2)
    amb = [a["tag"] for a in annotations if a["ambiguous"]]
    print(f"OK: {len(annotations)} quotes placed -> {out_path}")
    if amb:
        print(f"WARNING: quote text occurs more than once for {amb}; the hinted page was used. "
              "Lengthen those quotes to make them unique.", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
