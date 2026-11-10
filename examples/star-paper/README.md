# Example output: one real run

Output of `claude -p "/paper-review …"` (Claude Sonnet 5.5, profile `robotics`) on the public paper *STAR: Learning Diverse Robot Skill Abstractions through Rotation-Augmented Vector Quantization* (Li et al., ICML 2025, arXiv:2506.03863). The PDF is **not** included; download it from arXiv to reproduce the check below.

| File | What it is |
|---|---|
| `evidence.json` | Claude's evidence list: tag, type, page, section, short quote, comment |
| `annotations.json` | Zotero annotation JSON made by `locate_quotes.py` (39 highlights) |
| `review.md` | the review (ASD-STE100) |
| `note.html` | the Zotero note; tags are `zotero-ev://TAG` links that the plugin rewrites |
| `review.pdf` | the review as PDF |
| `result.json` | the contract file the plugin reads |

Re-locate the quotes yourself (needs the arXiv PDF and `pip install pymupdf pyyaml`):

```bash
python3 ../../skill/paper-review/scripts/locate_quotes.py 2506.03863v3.pdf evidence.json /tmp/annotations.json \
        --profile ../../skill/paper-review/profiles/robotics.yaml
```

The review is a machine-written aid. It was not checked line by line by a human, so verify its claims before you rely on them.
