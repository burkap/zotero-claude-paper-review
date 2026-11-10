#!/usr/bin/env python3
"""Check the review, build note.html and review.pdf, write result.json.

Usage:
  finalize.py --dir OUTDIR --pdf paper.pdf --profile profile.yaml [--title "Paper title"]

Reads OUTDIR/evidence.json, OUTDIR/annotations.json (from locate_quotes.py) and
OUTDIR/review.md. Writes OUTDIR/note.html, OUTDIR/review.pdf, OUTDIR/result.json.
result.json is the file the Zotero plugin reads.

review.md rules: "## <section title>" headings exactly as in the profile; evidence
tags written as [W2]; markdown subset: headings, "-" bullets, "1." lists, **bold**,
*italic*, `code`. No tables.
"""
import argparse
import html
import json
import os
import re
import sys

import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from profile_loader import load_profile  # noqa: E402

TAG_RE = re.compile(r"\[([A-Z]\d+)\]")


def inline(text, link_tags):
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    if link_tags:
        text = TAG_RE.sub(lambda m: f'<a href="zotero-ev://{m.group(1)}">[{m.group(1)}]</a>', text)
    return text


def md_to_html(md, link_tags=True):
    out, in_ul, in_ol, para = [], False, False, []

    def close_lists():
        nonlocal in_ul, in_ol
        if in_ul:
            out.append("</ul>")
            in_ul = False
        if in_ol:
            out.append("</ol>")
            in_ol = False

    def flush():
        if para:
            out.append("<p>" + inline(" ".join(para), link_tags) + "</p>")
            para.clear()

    for raw in md.splitlines():
        line = raw.rstrip()
        m = re.match(r"^(#{1,4})\s+(.*)", line)
        if m:
            flush(); close_lists()
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2), False)}</h{n}>")
        elif re.match(r"^\s*[-*]\s+", line):
            flush()
            if in_ol:
                out.append("</ol>"); in_ol = False
            if not in_ul:
                out.append("<ul>"); in_ul = True
            out.append("<li>" + inline(re.sub(r"^\s*[-*]\s+", "", line), link_tags) + "</li>")
        elif re.match(r"^\s*\d+[.)]\s+", line):
            flush()
            if in_ul:
                out.append("</ul>"); in_ul = False
            if not in_ol:
                out.append("<ol>"); in_ol = True
            out.append("<li>" + inline(re.sub(r"^\s*\d+[.)]\s+", "", line), link_tags) + "</li>")
        elif not line.strip():
            flush(); close_lists()
        else:
            close_lists()
            para.append(line.strip())
    flush(); close_lists()
    return "\n".join(out)


def evidence_table(evidence, annotations, link_tags=True):
    placed = {a["tag"]: a for a in annotations}
    rows = []
    for ev in evidence:
        a = placed[ev["tag"]]
        tag = ev["tag"]
        tag_html = f'<a href="zotero-ev://{tag}">[{tag}]</a>' if link_tags else f"[{tag}]"
        rows.append(
            f"<tr><td>{tag_html}</td><td>{html.escape(a['evidenceType'])}</td>"
            f"<td>p. {html.escape(a['annotationPageLabel'])}</td>"
            f"<td>{html.escape(ev.get('section', ''))}</td>"
            f"<td>&ldquo;{html.escape(a['annotationText'])}&rdquo;</td></tr>")
    head = ("<tr><th>Tag</th><th>Type</th><th>Page</th><th>Section</th><th>Quote</th></tr>")
    return ("<h2>Evidence</h2>\n<table border=\"1\" cellpadding=\"4\">" + head + "".join(rows) + "</table>")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--profile", required=True)
    ap.add_argument("--title", default="")
    args = ap.parse_args()
    d = args.dir

    profile = load_profile(args.profile)
    with open(os.path.join(d, "evidence.json"), encoding="utf-8") as f:
        evidence = json.load(f)["evidence"]
    with open(os.path.join(d, "annotations.json"), encoding="utf-8") as f:
        annotations = json.load(f)["annotations"]
    with open(os.path.join(d, "review.md"), encoding="utf-8") as f:
        review = f.read()

    errors = []
    # 1. every required section is present, in order
    pos = -1
    for sec in profile["sections"]:
        m = re.search(r"^##\s+" + re.escape(sec["title"]) + r"\s*$", review, re.M)
        if not m:
            errors.append(f"missing section heading: ## {sec['title']}")
        elif m.start() < pos:
            errors.append(f"section out of order: {sec['title']}")
        else:
            pos = m.start()
    # 2. tags in the review are known; every evidence tag is cited
    known = {a["tag"] for a in annotations}
    cited = set(TAG_RE.findall(review))
    for t in sorted(cited - known):
        errors.append(f"review.md cites unknown tag [{t}]")
    for t in sorted(known - cited):
        errors.append(f"evidence tag [{t}] is not cited in review.md")
    ev_tags = {e["tag"] for e in evidence}
    if ev_tags != known:
        errors.append(f"evidence.json and annotations.json differ: {sorted(ev_tags ^ known)}")
    # 3. sections with `starts_with: [Yes, No]` must begin with one of those words
    for sec in profile["sections"]:
        words = [str(w) for w in (sec.get("starts_with") or [])]
        if not words:
            continue
        m = re.search(r"^##\s+" + re.escape(sec["title"]) + r"\s*$\n+(.*)", review, re.M)
        if m and not re.match(r"\W*(" + "|".join(map(re.escape, words)) + r")\b", m.group(1)):
            errors.append(f"section '{sec['title']}' must start with one of: {', '.join(words)}")
    if errors:
        print("FAILED checks:", file=sys.stderr)
        for e in errors:
            print(" -", e, file=sys.stderr)
        sys.exit(2)

    title = args.title or os.path.splitext(os.path.basename(args.pdf))[0]
    body = md_to_html(review, True) + "\n" + evidence_table(evidence, annotations, True)
    note = f"<h1>Claude review: {html.escape(title)}</h1>\n" + body
    with open(os.path.join(d, "note.html"), "w", encoding="utf-8") as f:
        f.write(note)

    # review.pdf: tags are plain text here (links to Zotero do not work in a PDF)
    pdf_html = ("<h1>Claude review: " + html.escape(title) + "</h1>\n" + md_to_html(review, False)
                + "\n" + evidence_table(evidence, annotations, False))
    css = ("body{font-family:sans-serif;font-size:10pt} h1{font-size:16pt} h2{font-size:13pt} "
           "td,th{font-size:8pt;vertical-align:top} code{font-family:monospace}")
    story = pymupdf.Story(html=pdf_html, user_css=css)
    writer = pymupdf.DocumentWriter(os.path.join(d, "review.pdf"))
    page_rect, where = pymupdf.paper_rect("a4"), pymupdf.paper_rect("a4") + (50, 50, -50, -50)
    more = 1
    while more:
        dev = writer.begin_page(page_rect)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()

    result = {
        "schema": "claude-review/1",
        "profile": profile["name"],
        "title": title,
        "source_pdf": os.path.basename(args.pdf),
        "annotations_file": "annotations.json",
        "note_html_file": "note.html",
        "review_pdf_file": "review.pdf",
        "tags": sorted(known),
        "counts": {t: sum(1 for a in annotations if a["evidenceType"] == t)
                   for t in ("claim", "strength", "weakness", "question")},
    }
    with open(os.path.join(d, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print("OK:", json.dumps(result["counts"]), "->", os.path.join(d, "result.json"))


if __name__ == "__main__":
    main()
