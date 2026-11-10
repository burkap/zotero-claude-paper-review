/* Profile editor in Zotero > Settings > Review with Claude.
 * Uses only HTML elements (select, textarea, button), so Node + jsdom can test it.
 * All file and process access is injected:
 *   io: { list() -> [{name, path}], read(path), write(path, text), remove(path), join(name) -> path }
 *   check(text, fileName) -> { ok, error | name, chain, style, sections, checks:[{id,title,from}] }
 *   ui: { prompt(message, value) -> string|null, confirm(message) -> bool }
 *   prefs: { getDefault() -> path|"", setDefault(path) } */
var createProfileEditor = function ({ document: doc, Core, io, check, ui, prefs, onChanged = () => {} }) {
  const $ = (id) => doc.getElementById(id);
  let current = null;      // path of the profile in the editor
  let savedText = "";      // text on disk, to detect unsaved changes
  let profiles = [];

  const SNIPPETS = {
    check: [
      "  - id: my_check",
      "    title: Title of the check (a sub-heading in Detailed comments)",
      "    ask: >",
      "      What Claude must look for in every paper, in plain words.",
      "",
    ].join("\n"),
    style: [
      "language:",
      "  style: natural academic English   # or ASD-STE100, formal academic English, ...",
      "  quotes: verbatim",
      "",
    ].join("\n"),
  };

  function setStatus(text, kind) {
    let s = $("cr-status");
    s.textContent = text;
    s.style.color = kind === "err" ? "#c22" : kind === "ok" ? "#0a6" : "";
  }
  function dirty() { return current && $("cr-yaml").value !== savedText; }
  function confirmDiscard() { return !dirty() || ui.confirm("The profile has unsaved changes. Discard them?"); }

  async function refresh(selectPath) {
    profiles = await io.list();
    let sel = $("cr-edit-picker");
    sel.textContent = "";
    let def = prefs.getDefault();
    for (let p of profiles) {
      let o = doc.createElement("option");
      o.value = p.path;
      o.textContent = p.name + (p.path === def ? "  (default)" : "");
      sel.appendChild(o);
    }
    let target = selectPath || current || def || (profiles[0] && profiles[0].path);
    if (!profiles.some((p) => p.path === target)) target = profiles[0] && profiles[0].path;
    if (target) { sel.value = target; await load(target); }
    else { current = null; savedText = ""; $("cr-yaml").value = ""; setStatus("No profiles found."); }
    onChanged(profiles);
  }

  async function load(path) {
    let text = await io.read(path);
    current = path; savedText = text;
    $("cr-yaml").value = text;
    $("cr-info").textContent = "";
    setStatus(`Editing ${Core.profileName(path)}.yaml`);
    $("cr-default").disabled = path === prefs.getDefault();
  }

  function askName(message, value) {
    let name = ui.prompt(message, value);
    if (name === null || name === undefined) return null;
    name = name.trim().replace(/\.ya?ml$/i, "");
    if (!Core.validProfileName(name)) { setStatus("Use letters, digits, - and _ only (for example my-field-short).", "err"); return null; }
    if (profiles.some((p) => p.name === name)) { setStatus(`A profile named ${name} already exists.`, "err"); return null; }
    return name;
  }

  function withName(text, name) {
    return /^name:.*$/m.test(text) ? text.replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}\n` + text;
  }

  function describe(info, fileName) {
    if (!info.ok) return "Error: " + info.error;
    let chain = info.chain.map((c, i) => (i === 0 ? fileName : c)).join(" → ");
    let lines = [
      `Profile: ${info.name}   (${chain})`,
      `Style: ${info.style}`,
      "",
      `Sections (${info.sections.length}):`,
      ...info.sections.map((s, i) => `  ${i + 1}. ${s}`),
      "",
      `Checks Claude does on every paper (${info.checks.length}):`,
      ...info.checks.map((c, i) => `  ${String(i + 1).padStart(2)}. ${c.title}   [${c.id}, from ${c.from === info.chain[0] ? fileName : c.from}]`),
    ];
    return lines.join("\n");
  }

  async function runCheck() {
    if (!current) return null;
    let fileName = Core.profileName(current) + ".yaml";
    setStatus("Checking…");
    let info;
    try { info = await check($("cr-yaml").value, fileName); }
    catch (e) { info = { ok: false, error: String(e.message || e) }; }
    $("cr-info").textContent = describe(info, fileName);
    setStatus(info.ok ? "The profile is valid." : "The profile has an error. Nothing was saved.", info.ok ? "ok" : "err");
    return info;
  }

  const actions = {
    async select() {
      let path = $("cr-edit-picker").value;
      if (path === current) return;
      if (!confirmDiscard()) { $("cr-edit-picker").value = current; return; }
      await load(path);
    },
    async save() {
      let info = await runCheck();
      if (!info || !info.ok) return false;
      await io.write(current, $("cr-yaml").value);
      savedText = $("cr-yaml").value;
      setStatus(`Saved ${Core.profileName(current)}.yaml. The next review uses it.`, "ok");
      onChanged(profiles);
      return true;
    },
    check: runCheck,
    async create() {
      if (!confirmDiscard()) return;
      let name = askName("Name of the new profile (letters, digits, - and _):", "");
      if (!name) return;
      let tpl = profiles.find((p) => p.name === "template");
      let text = tpl ? await io.read(tpl.path)
        : "extends: default.yaml\nname: x\ndescription: My profile\n\nchecks:\n" + SNIPPETS.check;
      let path = io.join(name + ".yaml");
      await io.write(path, withName(text, name));
      await refresh(path);
      setStatus(`Made ${name}.yaml from the template. Edit it, then click Save.`, "ok");
    },
    async duplicate() {
      if (!current) return;
      let name = askName(`Name of the copy of ${Core.profileName(current)}:`, Core.profileName(current) + "-copy");
      if (!name) return;
      let path = io.join(name + ".yaml");
      await io.write(path, withName($("cr-yaml").value, name));
      await refresh(path);
      setStatus(`Made ${name}.yaml.`, "ok");
    },
    async remove() {
      if (!current) return;
      let name = Core.profileName(current), file = name + ".yaml";
      if (name === "default") { setStatus("default.yaml is the base of the other profiles. It cannot be deleted.", "err"); return; }
      let users = [];
      for (let p of profiles) {
        if (p.path === current) continue;
        let t = await io.read(p.path);
        if (new RegExp("^extends:\\s*['\"]?" + file.replace(/\./g, "\\.") + "['\"]?\\s*$", "m").test(t)) users.push(p.name);
      }
      if (users.length) { setStatus(`${file} cannot be deleted: ${users.join(", ")} extends it.`, "err"); return; }
      if (!ui.confirm(`Delete the profile ${file}? This cannot be undone.`)) return;
      await io.remove(current);
      if (prefs.getDefault() === current) prefs.setDefault("");
      current = null; savedText = "";
      await refresh();
      setStatus(`Deleted ${file}.`, "ok");
    },
    async makeDefault() {
      if (!current) return;
      if (dirty() && !(await actions.save())) return;
      prefs.setDefault(current);
      await refresh(current);
      setStatus(`${Core.profileName(current)} is now the default profile.`, "ok");
    },
    insert(kind) {
      let ta = $("cr-yaml"), snip = SNIPPETS[kind];
      let at = ta.selectionStart ?? ta.value.length;
      if (kind === "check" && !/^checks:/m.test(ta.value)) { snip = "\nchecks:\n" + snip; at = ta.value.length; }
      ta.value = ta.value.slice(0, at) + snip + ta.value.slice(at);
      setStatus(kind === "check" ? "Check inserted. Change the id, title and ask text, then Save." : "Style inserted. Remove any other language: block.");
    },
    get current() { return current; },
    isDirty: dirty,
    refresh,
  };

  function bind() {
    $("cr-edit-picker").addEventListener("change", () => actions.select());
    $("cr-save").addEventListener("click", () => actions.save());
    $("cr-check").addEventListener("click", () => actions.check());
    $("cr-new").addEventListener("click", () => actions.create());
    $("cr-dup").addEventListener("click", () => actions.duplicate());
    $("cr-del").addEventListener("click", () => actions.remove());
    $("cr-default").addEventListener("click", () => actions.makeDefault());
    $("cr-insert-check").addEventListener("click", () => actions.insert("check"));
    $("cr-insert-style").addEventListener("click", () => actions.insert("style"));
    $("cr-yaml").addEventListener("keydown", (ev) => {
      // Tab inserts two spaces (YAML does not allow tabs).
      if (ev.key === "Tab") {
        ev.preventDefault();
        let ta = ev.target, a = ta.selectionStart, b = ta.selectionEnd;
        ta.value = ta.value.slice(0, a) + "  " + ta.value.slice(b);
        ta.selectionStart = ta.selectionEnd = a + 2;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") { ev.preventDefault(); actions.save(); }
    });
    $("cr-yaml").addEventListener("input", () => { if (dirty()) setStatus(`Editing ${Core.profileName(current)}.yaml (not saved)`); });
  }

  bind();
  return actions;
};

if (typeof module !== "undefined") module.exports = createProfileEditor;
