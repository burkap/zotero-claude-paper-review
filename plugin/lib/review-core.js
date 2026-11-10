/* Pure helpers for "Review with Claude". No Zotero or Mozilla globals are used here,
 * so Node can test them. Loaded by bootstrap.js (loadSubScript) and by test/. */
var ClaudeReviewCore = {
  TAG: "claude-review",

  // Variables that would make `claude -p` use an API key or a cloud provider
  // instead of the logged-in subscription (precedence list in the Claude Code docs).
  BLOCKED_ENV: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],

  // Tools the skill needs: read files, write the output files, run python scripts.
  ALLOWED_TOOLS: ["Read", "Write", "Edit", "Bash(python3 *)", "Bash(python *)", "Bash(ls *)", "Bash(mkdir *)", "Bash(cat *)", "Bash(echo *)", "Bash(test *)"],

  buildPrompt({ pdf, profile, out }) {
    return `/paper-review Review the paper PDF with the paper-review skill. PDF=${pdf} PROFILE=${profile} OUT=${out}. ` +
      "Run every step of the skill. Write all output files to OUT. " +
      "The last file you write is OUT/result.json.";
  },

  buildArgs({ prompt, model, maxTurns, stream }) {
    let args = [
      "-p", prompt,
      "--output-format", stream ? "stream-json" : "json",
      ...(stream ? ["--verbose"] : []), // every documented stream-json example uses --verbose
      "--allowedTools", this.ALLOWED_TOOLS.join(","),
      "--permission-mode", "dontAsk", // deny anything not allowed; never wait for a prompt
      "--no-session-persistence",
    ];
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (model && model !== "default") args.push("--model", model);
    return args;
  },

  // `environment` for Subprocess.call with environmentAppend: true.
  // A value of null removes the variable from the inherited environment.
  buildEnvironment({ inheritedPath, extraDirs }) {
    let env = {};
    for (let k of this.BLOCKED_ENV) env[k] = null;
    // Zotero started from the Dock has a short PATH. `claude` is a script that needs node.
    let dirs = [...extraDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    if (inheritedPath) dirs.push(...inheritedPath.split(":"));
    env.PATH = [...new Set(dirs.filter(Boolean))].join(":");
    return env;
  },

  parseClaudeJson(stdout) {
    let text = (stdout || "").trim();
    let obj;
    try {
      obj = JSON.parse(text);
    }
    catch (e) {
      // stream-json: one JSON object per line. The last line is not always the result
      // (a real run ended with a system/task_summary line), so take the last "result" line.
      let parsed = [];
      for (let line of text.split("\n")) {
        try { parsed.push(JSON.parse(line)); } catch (e2) { /* not JSON */ }
      }
      obj = parsed.filter((o) => o && o.type === "result").pop() || parsed[parsed.length - 1];
    }
    if (!obj) throw new Error("claude did not print JSON: " + text.slice(0, 300));
    if (Array.isArray(obj)) obj = obj.filter((o) => o && o.type === "result").pop() || obj[obj.length - 1];
    return obj;
  },

  // One line of `--output-format stream-json` -> [{kind, text}] for the live log.
  // Defensive: the line shapes are not documented on the pages I read, so unknown lines give [].
  summarizeStreamLine(obj) {
    let out = [];
    if (!obj || typeof obj !== "object") return out;
    let short = (t, n) => { t = String(t).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
    let base = (p) => String(p || "").split("/").pop();
    if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
      for (let b of obj.message.content) {
        if (b.type === "text" && b.text && b.text.trim()) out.push({ kind: "text", text: short(b.text, 400) });
        else if (b.type === "tool_use") {
          let i = b.input || {};
          let what = b.name === "Bash" ? short(i.command, 160)
            : b.name === "Read" ? base(i.file_path) + (i.pages ? ` pages ${i.pages}` : "")
            : (b.name === "Write" || b.name === "Edit") ? base(i.file_path)
            : short(JSON.stringify(i), 100);
          out.push({ kind: "tool", text: `${b.name}: ${what}` });
        }
      }
    }
    else if (obj.type === "user" && obj.message && Array.isArray(obj.message.content)) {
      for (let b of obj.message.content) {
        if (b.type === "tool_result" && b.is_error) out.push({ kind: "err", text: "tool error: " + short(typeof b.content === "string" ? b.content : JSON.stringify(b.content), 200) });
      }
    }
    else if (obj.type === "system" && obj.subtype === "api_retry") {
      out.push({ kind: "err", text: `API retry ${obj.attempt}/${obj.max_retries} (${obj.error_status || obj.error || "error"})` });
    }
    return out;
  },

  // Profile files: *.yaml / *.yml, not hidden (the editor writes hidden temp files for validation).
  isProfileFile(name) { return /\.ya?ml$/i.test(name) && !String(name).startsWith("."); },
  profileName(path) { return String(path).split("/").pop().replace(/\.ya?ml$/i, ""); },
  validProfileName(name) { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(name || ""); },

  // Items of the "Review with Claude" submenu: default first, then one per profile.
  // `slots` is the fixed number of profile items (Zotero's MenuManager menus are static).
  profileMenuModel({ profiles, defaultPath, slots }) {
    let def = profiles.find((p) => p.path === defaultPath);
    let items = [{ kind: "default", label: `Default profile (${def ? def.name : this.profileName(defaultPath || "default.yaml")})`, path: null }];
    for (let i = 0; i < slots; i++) {
      let p = profiles[i];
      items.push(p ? { kind: "profile", label: p.name + (p.path === defaultPath ? "  (default)" : ""), path: p.path, visible: true }
        : { kind: "profile", label: "", path: null, visible: false });
    }
    let hidden = Math.max(0, profiles.length - slots);
    return { items, hidden };
  },

  // Python run by the profile editor: load the profile (with extends) and report
  // the effective sections and checks, and the file that defines each check.
  PROFILE_INFO_PY: [
    "import json, os, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import yaml",
    "from profile_loader import load_profile",
    "path = sys.argv[2]",
    "try:",
    "    merged = load_profile(path)",
    "    chain, p = [], os.path.abspath(path)",
    "    while p:",
    "        with open(p, encoding='utf-8') as f:",
    "            d = yaml.safe_load(f) or {}",
    "        chain.append((os.path.basename(p), d))",
    "        p = os.path.join(os.path.dirname(p), d['extends']) if d.get('extends') else None",
    "    origin = {}",
    "    for name, d in reversed(chain):",
    "        for c in d.get('checks') or []:",
    "            origin[c['id']] = name",
    "        for rid in d.get('remove_checks') or []:",
    "            origin.pop(rid, None)",
    "    secs = merged.get('sections') or []",
    "    bad = [i for i, s in enumerate(secs) if not s.get('title')]",
    "    if not secs or bad: raise ValueError('every section needs a title (sections: %s)' % bad)",
    "    for c in merged.get('checks') or []:",
    "        if not c.get('id') or not c.get('title') or not c.get('ask'): raise ValueError('every check needs id, title and ask: %r' % c.get('id'))",
    "    print(json.dumps({'ok': True, 'name': merged.get('name'), 'chain': [n for n, _ in chain],",
    "        'style': (merged.get('language') or {}).get('style', 'ASD-STE100'),",
    "        'sections': [s.get('title') for s in secs],",
    "        'checks': [{'id': c['id'], 'title': c.get('title'), 'from': origin.get(c['id'])} for c in merged.get('checks') or []]}))",
    "except Exception as e:",
    "    print(json.dumps({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}))",
  ].join("\n"),

  validateResult(result) {
    if (!result || result.schema !== "claude-review/1") {
      throw new Error("result.json has an unknown schema: " + (result && result.schema));
    }
    for (let k of ["annotations_file", "note_html_file"]) {
      if (!result[k]) throw new Error(`result.json is missing ${k}`);
    }
  },

  // annotations.json entry (Zotero item JSON names) -> argument of Zotero.Annotations.saveFromJSON
  // (names read from chrome/content/zotero/xpcom/annotations.js in Zotero 10.0.6).
  mapAnnotation(a, key) {
    for (let f of ["annotationType", "annotationColor", "annotationPageLabel", "annotationSortIndex", "annotationPosition"]) {
      if (a[f] === undefined || a[f] === null || a[f] === "") throw new Error(`annotation ${a.tag}: missing ${f}`);
    }
    if (a.annotationType !== "highlight") throw new Error(`annotation ${a.tag}: only highlight is supported`);
    if (!/^\d{5}\|\d{6}\|\d{5}$/.test(a.annotationSortIndex)) throw new Error(`annotation ${a.tag}: bad sortIndex`);
    if (!/^#[a-f0-9]{6}$/.test(a.annotationColor)) throw new Error(`annotation ${a.tag}: bad color`);
    let pos = a.annotationPosition;
    if (typeof pos === "string") pos = JSON.parse(pos);
    if (!Number.isInteger(pos.pageIndex) || !Array.isArray(pos.rects) || !pos.rects.length) {
      throw new Error(`annotation ${a.tag}: bad position`);
    }
    return {
      key,
      type: "highlight",
      text: a.annotationText,
      comment: a.annotationComment || "",
      color: a.annotationColor,
      pageLabel: a.annotationPageLabel,
      sortIndex: a.annotationSortIndex,
      position: pos, // saveFromJSON stringifies it
      tags: [{ name: this.TAG }],
    };
  },

  // zotero://open-pdf/library/items/<KEY>?page=N&annotation=<KEY>  (ZoteroProtocolHandler.mjs)
  annotationUrl({ groupID, attachmentKey, page, annotationKey }) {
    let lib = groupID ? `groups/${groupID}` : "library";
    return `zotero://open-pdf/${lib}/items/${attachmentKey}?page=${page}&annotation=${annotationKey}`;
  },

  // Replace href="zotero-ev://TAG" in note.html with the real links.
  rewriteNoteLinks(html, links) {
    return html.replace(/href="zotero-ev:\/\/([A-Z]\d+)"/g, (m, tag) => {
      if (!links[tag]) throw new Error(`note.html cites tag ${tag} that has no annotation`);
      return `href="${links[tag]}"`;
    });
  },
};

if (typeof module !== "undefined") module.exports = ClaudeReviewCore;
