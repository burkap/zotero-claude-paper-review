# How it works

## The pieces

- **Plugin** (`plugin/`): a bootstrapped Zotero plugin (`manifest.json` + `bootstrap.js`). It adds the menu, the settings pane, the queue and the profile editor. For each paper it copies the PDF and the profile folder into a temp folder, starts `claude -p` with Mozilla's `Subprocess` module, reads the result files and writes into Zotero.
- **Skill** (`skill/paper-review/`): a Claude Code skill. `SKILL.md` tells Claude the steps. The scripts do the parts that must be exact.
- **Profile** (`skill/paper-review/profiles/*.yaml`): the configuration (see [PROFILES.md](PROFILES.md)).

## The run

The plugin starts (simplified):

```
claude -p "/paper-review … PDF=<tmp>/paper.pdf PROFILE=<tmp>/profiles/<p>.yaml OUT=<tmp>/out" \
       --output-format stream-json --verbose \
       --allowedTools "Read,Write,Edit,Bash(python3 *),Bash(python *),Bash(ls *),Bash(mkdir *),Bash(cat *),Bash(echo *),Bash(test *)" \
       --permission-mode dontAsk --no-session-persistence --max-turns 80 [--model …]
```

with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the cloud-provider switches removed from the environment, and `PATH` extended so `claude` (a script that needs Node) and `python3` are found when Zotero was started from the Dock. `--permission-mode dontAsk` means nothing can wait for a prompt; only the listed tools run.

The skill steps:

1. `extract_text.py` writes `paper.txt` with `=== PAGE n ===` markers, in column-aware reading order.
2. Claude applies every check of the profile and writes `evidence.json`.
3. `locate_quotes.py` finds each quote in the PDF and writes `annotations.json`.
4. Claude writes `review.md` using the profile's section headings.
5. `finalize.py` checks the review, builds `note.html` and `review.pdf`, and writes `result.json`.

The plugin watches the output folder to show the step (`paper.txt` → step 1, `evidence.json` → 2, …) and reads the stream output for the live log.

## Evidence and quote location

`evidence.json` entries:

```json
{"tag": "W2", "type": "weakness", "page": 7, "section": "4.4 Ablation Study",
 "quote": "(w/o Rotation) leads to degraded performance (91.0% overall)",
 "comment": "Without rotation the score is still 91.0%, far above QueST (81.5%)."}
```

`locate_quotes.py`:

- builds a normalised text (Unicode NFKC, lower case, letters and digits only) from the PDF words in reading order, so line breaks, hyphenation at line ends, ligatures and spacing do not matter;
- tries the PDF content-stream order first, then a column-aware block order, so quotes that cross a line, a column or a page break are found;
- **exits with code 2 and writes nothing** if any quote is missing, too long (≥ 15 words), too short to be unique, or has an unknown type. It lists the failing quotes and the nearest text it found. It never invents a position;
- writes one Zotero annotation per quote: `annotationType: "highlight"`, `annotationText` (the PDF's own text), `annotationComment` (`[W2] …`), `annotationColor`, `annotationPageLabel`, `annotationSortIndex` (`PPPPP|OOOOOO|YYYYY`) and `annotationPosition` (`{"pageIndex": n, "rects": [[x1, y1, x2, y2], …]}`). Rects are in **PDF user space with the origin at the bottom-left** (PyMuPDF uses top-left, so every rect is converted back with the inverse page transformation matrix).

`examples/star-paper/` contains a real run: all highlights were checked by reading the text under each converted rect with an independent conversion.

## The result contract (`result.json`)

```json
{"schema": "claude-review/1", "profile": "robotics", "title": "…", "source_pdf": "paper.pdf",
 "annotations_file": "annotations.json", "note_html_file": "note.html", "review_pdf_file": "review.pdf",
 "tags": ["C1", "S1", "W1"], "counts": {"claim": 1, "strength": 1, "weakness": 1, "question": 0}}
```

## Writing into Zotero

- Each annotation goes through `Zotero.Annotations.saveFromJSON(attachment, json)` with a generated key and the tag `claude-review`. Field names and validation rules were read in the Zotero 10.0.6 source (`annotations.js`, `item.js`).
- `note.html` has links `zotero-ev://W2`. The plugin replaces them with `zotero://open-pdf/library/items/<ATTACHMENT KEY>?page=N&annotation=<ANNOTATION KEY>` (`groups/<id>/…` for group libraries) and saves the note as a child of the paper, tagged `claude-review`.
- With the PDF option on, `review.pdf` is imported with `Zotero.Attachments.importFromFile`.
- **Idempotence:** new items are saved first. Only then are the older items tagged `claude-review` (highlights, notes, review PDFs) deleted. Items without that tag are never touched. When looking for the source PDF, attachments tagged `claude-review` are skipped.

## Queue

One worker, one paper at a time, in memory. Each job keeps its own state, log, profile and cancel handle. Cancel kills the `claude` process and writes nothing. In the last seconds, while Zotero saves the result, Cancel is refused so that a half-written result cannot happen.
