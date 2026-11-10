/* global Zotero, IOUtils, PathUtils, Services, document, window, ChromeUtils, Components, ClaudeReviewCore, createProfileEditor */
// Script of the preference pane. Loaded by Zotero.PreferencePanes.register (scripts: [...]).
var ClaudeReviewPrefs = {
  P: "extensions.claude-review.",

  init() {
    // Plain fields are bound with preference="..." in prefs.xhtml. Only the picker needs code.
    if (this._done) return;
    this._done = true;
    document.getElementById("claude-review-refresh").addEventListener("command", () => this.fillProfiles());
    document.getElementById("claude-review-skillDir").addEventListener("change", () => this.fillProfiles());
    let picker = document.getElementById("claude-review-profilePicker");
    // The command event can come from a menuitem, so read the selection from the menulist itself.
    picker.addEventListener("command", () => {
      let v = picker.selectedItem && picker.selectedItem.getAttribute("value");
      if (!v) return;
      Zotero.Prefs.set(this.P + "profilePath", v, true);
      let box = document.getElementById("claude-review-profilePath");
      box.value = v;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    this.fillProfiles();
    this.initEditor();
  },

  home() { return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path; },

  async python() {
    let dir = Zotero.Prefs.get(this.P + "pythonDir", true);
    let c = [dir && PathUtils.join(dir, "python3"), PathUtils.join(this.home(), "miniconda3", "bin", "python3"),
      "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].filter(Boolean);
    for (let p of c) { try { if (await IOUtils.exists(p)) return p; } catch (e) { /* next */ } }
    throw new Error("python3 not found. Set the python folder above.");
  },

  // Validate the editor text with the skill's own profile loader (python + PyYAML).
  async checkProfile(text, fileName) {
    let dir = PathUtils.join(this.skillDir(), "profiles");
    let tmp = PathUtils.join(dir, ".check-" + Zotero.Utilities.randomString(6) + "-" + fileName);
    await IOUtils.writeUTF8(tmp, text);
    try {
      const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      let proc = await Subprocess.call({
        command: await this.python(),
        arguments: ["-c", ClaudeReviewCore.PROFILE_INFO_PY, PathUtils.join(this.skillDir(), "scripts"), tmp],
        stderr: "stdout",
      });
      let out = "", chunk;
      while ((chunk = await proc.stdout.readString())) out += chunk;
      await proc.wait();
      let line = out.trim().split("\n").pop();
      try { return JSON.parse(line); }
      catch (e) { return { ok: false, error: out.trim().slice(0, 600) || "python printed nothing" }; }
    }
    finally {
      try { await IOUtils.remove(tmp); } catch (e) { /* ignore */ }
    }
  },

  initEditor() {
    if (!document.getElementById("cr-yaml")) return;
    let dir = () => PathUtils.join(this.skillDir(), "profiles");
    this.editor = createProfileEditor({
      document,
      Core: ClaudeReviewCore,
      io: {
        list: async () => {
          let files = [];
          try { files = await IOUtils.getChildren(dir()); } catch (e) { return []; }
          return files.filter((f) => ClaudeReviewCore.isProfileFile(PathUtils.filename(f)))
            .map((f) => ({ name: ClaudeReviewCore.profileName(f), path: f }))
            .sort((a, b) => a.name.localeCompare(b.name));
        },
        read: (p) => IOUtils.readUTF8(p),
        write: (p, t) => IOUtils.writeUTF8(p, t),
        remove: (p) => IOUtils.remove(p),
        join: (name) => PathUtils.join(dir(), name),
      },
      check: (text, fileName) => this.checkProfile(text, fileName),
      ui: {
        prompt: (msg, value) => { let o = { value: value || "" }; return Services.prompt.prompt(window, "Review with Claude", msg, o, null, {}) ? o.value : null; },
        confirm: (msg) => Services.prompt.confirm(window, "Review with Claude", msg),
      },
      prefs: {
        getDefault: () => Zotero.Prefs.get(this.P + "profilePath", true) || PathUtils.join(dir(), "default.yaml"),
        setDefault: (p) => {
          Zotero.Prefs.set(this.P + "profilePath", p, true);
          let box = document.getElementById("claude-review-profilePath");
          if (box) { box.value = p; box.dispatchEvent(new Event("change", { bubbles: true })); }
        },
      },
      onChanged: () => this.fillProfiles(),
    });
    this.editor.refresh().catch((e) => Zotero.logError(e));
  },

  skillDir() {
    let dir = Zotero.Prefs.get(this.P + "skillDir", true);
    return dir || PathUtils.join(Services.dirsvc.get("Home", Components.interfaces.nsIFile).path, ".claude", "skills", "paper-review");
  },

  async fillProfiles() {
    let popup = document.getElementById("claude-review-profilePopup");
    let picker = document.getElementById("claude-review-profilePicker");
    popup.replaceChildren();
    let dir = PathUtils.join(this.skillDir(), "profiles");
    let files = [];
    try {
      files = (await IOUtils.getChildren(dir)).filter((f) => ClaudeReviewCore.isProfileFile(PathUtils.filename(f))).sort();
    }
    catch (e) {
      Zotero.debug("claude-review: cannot list " + dir + ": " + e);
    }
    if (!files.length) {
      let none = document.createXULElement("menuitem");
      none.setAttribute("label", "No profiles found in " + dir);
      none.setAttribute("disabled", "true");
      popup.appendChild(none);
      picker.selectedItem = none;
      return;
    }
    let current = Zotero.Prefs.get(this.P + "profilePath", true) || PathUtils.join(dir, "default.yaml");
    for (let f of files) {
      let item = document.createXULElement("menuitem");
      item.setAttribute("label", PathUtils.filename(f).replace(/\.ya?ml$/, ""));
      item.setAttribute("value", f);
      popup.appendChild(item);
      if (f === current) picker.selectedItem = item;
    }
  },
};

// The pane fragment can be inserted after this script runs, and neither the onload attribute
// nor the window load event fired reliably in Zotero 10.0.6. So wait for the elements.
(function waitForPane(tries = 0) {
  if (document.getElementById("claude-review-profilePicker")) ClaudeReviewPrefs.init();
  else if (tries < 100) setTimeout(() => waitForPane(tries + 1), 100);
})();
