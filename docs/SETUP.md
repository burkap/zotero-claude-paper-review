# Setup

You need: Zotero 7+ (developed on 10.0.6), Claude Code logged in with a Claude Pro/Max account, and Python 3 with PyMuPDF.

## 1. Install Claude Code and log in with your subscription

1. Install Claude Code: <https://code.claude.com/docs/en/setup> (for example `curl -fsSL https://claude.ai/install.sh | bash`, or `brew install --cask claude-code`).
2. Open a new Terminal and run `claude`. Log in with your **Claude Pro/Max account** (not an API key).
3. Find the binary: `which claude`. The plugin searches `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. If yours is elsewhere, set the path in the plugin settings.

## 2. Make sure no API key is set

In `-p` mode an API key in the environment is used instead of your subscription, and costs API money.

```bash
echo "key is: ${ANTHROPIC_API_KEY:-unset}"     # must print: key is: unset
```

If not, remove the `export ANTHROPIC_API_KEY=…` line from `~/.zshrc`, `~/.zprofile` and `~/.zshenv`, and open a new Terminal.

The plugin also removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock/Vertex/Foundry switches from the environment of each `claude` run. A key set in `~/.claude/settings.json` (`apiKeyHelper`, `env`) is **not** removed by the plugin. Remove it there too.

## 3. Install PyMuPDF

```bash
pip install pymupdf pyyaml
python3 -c "import pymupdf, yaml; print(pymupdf.__version__)"
```

Zotero started from the Dock has a short `PATH`. In the plugin settings, put the folder of the `python3` that has PyMuPDF (for example `~/miniconda3/bin`) into **Folder of python3 with PyMuPDF**.

## 4. Install the skill

Download `paper-review-skill.zip` from the [latest release](../../../releases/latest).

```bash
mkdir -p ~/.claude/skills
unzip -o paper-review-skill.zip -d ~/.claude/skills
ls ~/.claude/skills/paper-review     # SKILL.md  scripts  profiles
```

Claude Code reads new skills without a restart. To update the skill later, unzip again (your own profiles in `profiles/` are not removed, but a file with the same name as a shipped profile is overwritten).

Test the skill without Zotero (replace the PDF path):

```bash
mkdir -p /tmp/rv && cd /tmp/rv
claude -p "/paper-review Review the paper PDF with the paper-review skill. PDF=/path/to/paper.pdf PROFILE=$HOME/.claude/skills/paper-review/profiles/default.yaml OUT=/tmp/rv/out. Run every step of the skill." \
  --output-format json \
  --allowedTools "Read,Write,Edit,Bash(python3 *),Bash(python *),Bash(ls *),Bash(mkdir *),Bash(cat *),Bash(echo *),Bash(test *)" \
  --permission-mode dontAsk
ls /tmp/rv/out     # result.json annotations.json evidence.json note.html review.md review.pdf paper.txt
```

If `python3` there is not the one with PyMuPDF, put it first in `PATH` for this test.

## 5. Install the plugin

1. Download `review-with-claude-<version>.xpi` from the [latest release](../../../releases/latest).
2. In Zotero: **Tools → Plugins → ⚙ → Install Plugin From File…** and select the file. Restart Zotero if it asks.
3. **Zotero → Settings → Review with Claude**:
   - **Path to the claude binary**: the output of `which claude`, or empty.
   - **Skill folder**: empty means `~/.claude/skills/paper-review`.
   - **Default profile**: choose in the profile editor (**Use as default**).
   - **Folder of python3 with PyMuPDF**: see step 3.
   - **Claude model**: *Default* lets Claude Code choose. Or pick an alias (`sonnet`, `opus`, `haiku`) or a fixed model.
   - **Timeout** (default 1200 s) and **Max turns** (default 80).
   - **Also attach the review as a PDF**: optional.

### Zotero newer than 10.0.x

The plugin declares `strict_max_version` `10.0.*`. If a newer Zotero shows it as incompatible, open `manifest.json` inside the `.xpi` (a zip file), raise `strict_max_version` (for example `10.1.*`), and install again. Zotero requires an `update_url` in the manifest; this plugin uses a placeholder, so there are no automatic updates.

## 6. Use it

1. Select one or more papers (parent items or their PDFs).
2. Right-click → **Review with Claude** → choose a profile. (**Edit profiles…** opens the settings.)
3. The queue panel opens at the bottom right of the Zotero window.

| Button | Where | What it does |
|---|---|---|
| ⏸ Pause queue / ▶ Resume queue | top | Pause: the running paper finishes, then nothing new starts. |
| ⏸ / ▶ | waiting paper | Pause this paper only, or put it back. |
| ↑ ↓ | waiting paper | Change the order. |
| ✕ | waiting paper | Remove it. |
| ✕ Cancel | running paper | Stop Claude for this paper. Nothing is written. (Not possible while Zotero saves the result.) |
| Open note | done paper | Select the review note. |
| ↻ Retry | failed or cancelled paper | Put it at the end of the queue (with its profile). |
| Clear finished / Clear waiting | top | Clean up the list. |

Click a row to see the live log of that paper. The queue lives in memory: closing Zotero stops the running paper and forgets the waiting ones.

A re-run replaces the earlier results: the new items are saved first, then the old items tagged `claude-review` are deleted. Your own highlights and notes are kept.

## 7. Usage limits (Pro/Max)

- A review uses your subscription limits (the same limits as claude.ai and Claude Code), not API money. One paper is a long run. A long queue can reach your limit. Pause the queue to keep some limit for other work.
- When a limit is reached, `claude` prints a message and the plugin shows it as an error. Wait for the reset, or pick a smaller model.
- If apps started from the Dock cannot see your login, run `claude setup-token` in Terminal and give Zotero the token with `launchctl setenv CLAUDE_CODE_OAUTH_TOKEN <token>`, then restart Zotero. Keep the token secret.

## 8. Troubleshooting

| Message | Action |
|---|---|
| `claude binary not found` | Set the path in the settings. |
| `Not logged in` / authentication error | Run `claude` in Terminal and log in. If Zotero still fails, use the `setup-token` step above. |
| `PyMuPDF or PyYAML is missing` | Step 3, and set the python folder in the settings. |
| `The paper-review skill is not installed` | Step 4. |
| `Permission to use Bash has been denied` | The run uses `--permission-mode dontAsk`. Use the skill and plugin from the same release; they agree on which commands are allowed. |
| `did not finish in N s` | Raise the timeout. |
| Plugin does not install | Step 5, "Zotero newer than 10.0.x". |

Zotero log: **Help → Debug Output Logging**, then search for `claude-review`.
