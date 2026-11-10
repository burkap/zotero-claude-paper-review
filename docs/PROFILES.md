# Profiles (the configuration)

A profile is a YAML file in `~/.claude/skills/paper-review/profiles/`. The skill contains **no field-specific text**. Everything that makes a review specific to a field or a course lives in the profile.

Edit profiles in Zotero (**Settings → Review with Claude → Profiles**, with a *Check* button), or with any text editor.

## Example profiles

| File | Extends | Purpose |
|---|---|---|
| `default.yaml` | – | Generic research papers. The base for the others. |
| `robotics.yaml` | `default` | Robot learning: demonstrations and trials, copied VLA baselines, sim vs real. |
| `nlp-llm.yaml` | `default` | NLP/LLM: contamination, judge-based evaluation, prompt sensitivity, scaling, cost. |
| `computer-vision.yaml` | `default` | Vision: datasets and splits, metric protocol, qualitative results, robustness, compute. |
| `theory.yaml` | `default` | Theory: statements, proofs, assumptions, tightness, novelty. Removes `baselines`, `data_budget`, `ablations`. |
| `template.yaml` | `default` | Starting point for your own. |

## Fields

```yaml
extends: default.yaml          # optional parent (same folder). Child values win.
name: my-field                 # shown in the menu
description: One line.

language:
  style: ASD-STE100            # any style rule Claude can follow: "natural academic English",
  quotes: verbatim             # "plain English", ... Quotes from the paper stay verbatim.

evidence:
  max_quote_words: 14          # quotes must be shorter than 15 words
  must_have: [tag, page, section, quote]

tag_prefix: {claim: C, strength: S, weakness: W, question: Q}   # tag letters, e.g. W2

colors:                        # Zotero highlight colours per evidence type
  claim:    {hex: "#ffd400", name: yellow, use: "claim or method detail"}
  strength: {hex: "#5fb236", name: green,  use: "strength evidence"}
  weakness: {hex: "#ff6666", name: red,    use: "weakness or problem"}
  question: {hex: "#2ea8e5", name: blue,   use: "open question"}

sections:                      # the review headings, in this exact order
  - id: summary
    title: Summary of contribution        # becomes "## Summary of contribution"
    guidance: >                           # what Claude must put in the section
      Main points, ideas and claims; how the methods are evaluated and where.
  - id: award
    title: Would you nominate this paper for the Best Paper Award? (Yes/No)
    starts_with: ["Yes", "No"]            # the first word must be one of these (checked by finalize.py)
    guidance: Start with "Yes" or "No", then give the reasons.

checks:                        # done on every paper, reported under "Detailed comments"
  - id: statistics
    title: Statistics, trials, seeds and variance
    ask: >
      How many seeds and trials? Is variance given? Is the gain bigger than the variance?

remove_checks: [data_budget]   # drop checks inherited from the parent
```

## Merge rules (`extends`)

- Dictionaries (`language`, `colors`, `tag_prefix`, `evidence`) merge key by key.
- `checks` merge **by `id`**: a new id adds a check, the same id replaces the parent's check, `remove_checks` removes one.
- Other lists, such as `sections`, **replace** the parent's list. Give all sections.
- Quote the words `"Yes"` and `"No"` in YAML (unquoted they become booleans).

## Rules that are checked for you

`finalize.py` refuses to finish a review when: a section heading is missing or out of order; a tag in the text has no evidence; an evidence tag is never cited; a `starts_with` rule is broken. `locate_quotes.py` refuses a quote that is not in the PDF, is longer than 14 words, or uses an unknown evidence type. Claude then fixes the files and runs the step again.

## Make your own

1. Zotero → Settings → Review with Claude → **Profiles** → **New…** (it starts from `template.yaml`). Or copy `template.yaml` to a new file.
2. Change only what differs from the parent. Press **Check** to see the sections and checks Claude will use, and which file each comes from.
3. **Save**. The next review uses it. No restart is needed.

Example: a course whose review form has its own headings.

```yaml
extends: default.yaml
name: my-course
language: {style: natural academic English, quotes: verbatim}
sections:
  - {id: summary,    title: Summary,       guidance: "What the paper claims and how it is evaluated."}
  - {id: strengths,  title: Strengths,     guidance: "Each strength cites a green [S#] tag."}
  - {id: weaknesses, title: Weaknesses,    guidance: "Each weakness cites a red [W#] tag."}
  - {id: verdict,    title: Verdict (Accept/Reject), starts_with: ["Accept", "Reject"], guidance: "Start with Accept or Reject."}
```
