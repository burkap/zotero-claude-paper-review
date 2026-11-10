## Review with Claude 0.4.0

Right-click a paper in Zotero and get an evidence-based review back as highlight annotations, a linked child note and an optional PDF, written by Claude Code on your own Claude Pro/Max subscription.

### Files
- `review-with-claude-0.4.0.xpi`: the Zotero plugin (Zotero 7 to 10.0.x). *Tools → Plugins → ⚙ → Install Plugin From File…*
- `paper-review-skill.zip`: the Claude skill. `unzip -o paper-review-skill.zip -d ~/.claude/skills`
- `SHA256SUMS`: checksums of both files.

### Highlights
- Review queue with pause, reorder, cancel, retry and a live log.
- Profile editor and five example profiles: `default`, `robotics`, `nlp-llm`, `computer-vision`, `theory` (plus `template`).
- Every quote is located in the PDF; a quote that cannot be found stops the run.

### Needs
Claude Code logged in with a Pro/Max account, Python 3 with `pymupdf` and `pyyaml`. See `docs/SETUP.md`.

### Known limits
Developed and used on macOS with Zotero 10.0.6. The plugin's UI features are tested with a simulated DOM, not in every Zotero version. The `nlp-llm`, `computer-vision` and `theory` profiles load and validate but were not run on papers yet.
