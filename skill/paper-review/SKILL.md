---
name: paper-review
description: Review a research paper PDF against a configurable checklist profile. Writes an evidence-based review in ASD-STE100 Simplified Technical English, with word-for-word quotes that are located in the PDF and turned into Zotero highlight annotations. Use when asked to review a paper, or when invoked by the Zotero "Review with Claude" plugin.
allowed-tools: Read Write Bash(python3 *) Bash(python *) Bash(ls *)
---

# paper-review

Input (given in the prompt or as arguments):
- `PDF`: absolute path of the paper PDF.
- `PROFILE`: absolute path of a profile YAML file (default: `${CLAUDE_SKILL_DIR}/profiles/default.yaml`; the skill is not tied to one field, all field knowledge is in the profile).
- `OUT`: output folder. Create it if it does not exist. Write all files there.

Output: `OUT/result.json` (the contract the Zotero plugin reads), plus `evidence.json`,
`annotations.json`, `review.md`, `note.html`, `review.pdf`, `paper.txt`.

Shell rules (the run may allow only some commands): run each Bash command alone. Do not chain commands with `&&`, `;` or `|`. Start each command with `python3`, `ls`, `mkdir` or `cat`. Use the Read tool to read files, not `cat` chained to other commands. `OUT` may already exist.

Run every step. Do not skip a check. Do not write a file by hand if a script writes it.

## Step 0. Check the tools

Run `python3 -c "import pymupdf, yaml"`. If it fails, stop and report: "PyMuPDF or PyYAML is missing. Run: pip install pymupdf pyyaml". Do not try to work around it.

## Step 1. Read the profile

Read `PROFILE` (the scripts resolve `extends:` for you; if the file has `extends`, also read the parent file it names, in the same folder). It sets: the review `sections` (fixed, in order), the `checks`, the `colors`, the `tag_prefix` per evidence type, and the evidence rules.

## Step 2. Extract the text with page numbers

```
python3 ${CLAUDE_SKILL_DIR}/scripts/extract_text.py "PDF" "OUT/paper.txt"
```

Read `OUT/paper.txt` completely (use Read with offset and limit if the file is long). Lines `=== PAGE n (label L) ===` give the PDF page number n. Use n in `evidence.json`.
Text from tables and figures can be broken. If a number matters, check it: render the page (`pymupdf` page.get_pixmap to a PNG in OUT, then Read the PNG).

## Step 3. Apply the profile checks

Go through every item in `checks`. For each check, search the whole paper, including the appendix. Compute numbers yourself: recompute differences, averages and percentages from the tables.
Write down what you find. If the paper does not report something, that is a finding ("not reported"). Do not guess. Do not use facts from outside the paper, except to say that a number is copied from another paper if the paper says so.

## Step 4. Write `OUT/evidence.json`

Format:

```json
{"evidence": [
  {"tag": "W2", "type": "weakness", "page": 7, "section": "4.4 Ablation Study",
   "quote": "removing the rotation-augmented gradient",
   "comment": "Ablation shows rotation explains little of the gain"}
]}
```

Rules:
- `tag` = the letter for the type (from `tag_prefix`) plus a number. Numbers start at 1 for each letter and have no gaps.
- `type` is `claim`, `strength`, `weakness` or `question`. The type sets the highlight color.
- `quote` is copied word for word from the paper text. Fewer than 15 words (at most 14). Use plain running text. Do not use equations, table cells, or words split by a figure. Do not fix typos. Do not join words from different places. The script finds the quote in the PDF. A quote that is not in the PDF stops the run.
- `page` is the PDF page number n from the `=== PAGE n` line. `section` is the section number and title (for example `4.4 Ablation Study`, `Appendix A.4`).
- `comment` is one short sentence, in the style of `language.style` of the profile (ASD-STE100 if the profile does not set it). The script adds the tag in front of it.
- Make a quote long enough to be unique on the page (at least 5 words).
- Use about 15 to 40 evidence items. Every claim in the review needs one. Include at least one `claim`, and at least one item for each check where you found a problem.

## Step 5. Locate the quotes

```
python3 ${CLAUDE_SKILL_DIR}/scripts/locate_quotes.py "PDF" "OUT/evidence.json" "OUT/annotations.json" --profile "PROFILE"
```

If the script exits with code 2, it lists each quote that was not found. Open the page in `paper.txt`, copy the exact words, fix `evidence.json`, and run the script again. Repeat until it prints `OK`. Never edit `annotations.json` by hand. Never invent a position.

## Step 6. Write `OUT/review.md`

Use the `sections` of the profile as `## <title>` headings, exactly as written, in the profile order. Follow each section's `guidance`. If a section has `starts_with`, its first word must be one of those words. (With the built-in profiles the headings are: Summary of contribution / Strengths / Weaknesses / Detailed comments / Would you nominate this paper for the Best Paper Award? and why?)

Rules:
- Write in the style set by `language.style` of the profile. For ASD-STE100 Simplified Technical English: short sentences (maximum 25 words, 20 in a procedure), one idea per sentence, active voice, simple present tense, plain common words, no idioms, no figures of speech, one word for one meaning, use "the paper" or "the authors". Technical names and terms from the paper (for example "codebook", "ablation", "LIBERO-Long") stay as they are.
- Do not copy long text from the paper. Quotes inside the review are only the short quotes of `evidence.json`.
- Cite evidence as a tag in square brackets, for example `[W2]`, directly after the claim. Each tag must exist in `evidence.json`. Cite every tag at least once. In "Detailed comments", use one `###` sub-heading per check and cite the evidence. Say "Not reported" or "No problem found" when this is true.
- State the page and section for each cited item in the text at least the first time (for example "[W2] (p. 7, Section 4.4)"). The note adds a table with tag, page, section and quote.
- Weaknesses: put the most serious first. Say how serious each one is and what the authors must do.
- A section with `starts_with` (the award section in the built-in profiles) starts with one of those words. Then give the reasons with tags.
- Markdown subset only: headings, `-` bullets, `1.` lists, `**bold**`, `*italic*`. No tables. No nested lists (one level of bullets only).

## Step 7. Finish

```
python3 ${CLAUDE_SKILL_DIR}/scripts/finalize.py --dir "OUT" --pdf "PDF" --profile "PROFILE" --title "<paper title>"
```

This checks the review (all profile sections, all tags known and cited, `starts_with` rules), builds `note.html` (every tag links to its highlight) and `review.pdf`, and writes `result.json`. If it fails, fix `review.md` or `evidence.json` and run Step 5 and Step 7 again.

When `finalize.py` prints `OK`, reply with one short line: the path of `result.json` and the number of annotations. Do not paste the review in the reply.

## Output contract (`result.json`)

```json
{"schema": "claude-review/1", "profile": "robotics", "title": "...",
 "source_pdf": "paper.pdf",
 "annotations_file": "annotations.json",
 "note_html_file": "note.html",
 "review_pdf_file": "review.pdf",
 "tags": ["C1", "S1", "W1"], "counts": {"claim": 1, "strength": 1, "weakness": 1, "question": 0}}
```

- `annotations.json`: `{"annotations": [...]}`; each item has `tag`, `evidenceType`, `annotationType`, `annotationText`, `annotationComment`, `annotationColor`, `annotationPageLabel`, `annotationSortIndex`, `annotationPosition` (`{"pageIndex": n, "rects": [[x1,y1,x2,y2], ...]}` in PDF user space, origin bottom-left).
- `note.html`: tags are links `zotero-ev://TAG`. The plugin replaces them with `zotero://open-pdf/library/items/<ATTACHMENT KEY>?page=N&annotation=<ANNOTATION KEY>`.
