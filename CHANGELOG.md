# Changelog

(Reconstructed from the development history; the first public release is 0.4.0.)

## 0.4.0
- Profile editor in the settings (list, New, Duplicate, Delete, Use as default, Insert check/style, Check, Save).
- Context-menu submenu to choose the profile for a run; each queued paper keeps its profile.
- Profiles can be written with a language style other than ASD-STE100.
- New example profiles: `nlp-llm`, `computer-vision`, `theory`.

## 0.3.0
- Review queue: several papers, one at a time. Pause/resume, reorder, cancel, retry, live log per paper.

## 0.2.x
- Live progress with Claude's actions, step display from the output files, Cancel.
- Model picker (aliases and fixed models). Profile picker fixes.
- Fixes found in real runs: Bash was denied under `dontAsk` when Claude chained commands (the skill now runs commands one by one, and the plugin allows `mkdir`, `cat`, `echo`, `test`); late progress updates no longer hide an error; menu IDs are unregistered before registering; the last line of a stream is not always the result line.

## 0.1.0
- First version: menu entry, `claude -p` through `Subprocess`, annotations through `saveFromJSON`, child note with links, optional review PDF, idempotent re-runs.
- Zotero 10 requires `applications.zotero.update_url` in `manifest.json`.
