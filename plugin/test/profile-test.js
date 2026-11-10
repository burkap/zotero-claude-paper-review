// Tests for profiles: menu model, the python profile check, the profile editor (jsdom),
// and the profile of each queued paper. Zotero is not started.
// Run: NODE_PATH=<dir with jsdom> node test/profile-test.js   (needs python3 with PyYAML)
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const Core = require("../lib/review-core.js");
const createProfileEditor = require("../lib/profile-editor.js");
const createReviewQueue = require("../lib/review-queue.js");
const createQueuePanel = require("../lib/queue-panel.js");

const SKILL = path.resolve(__dirname, "../../skill/paper-review");
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function pyCheck(dir) {
  return async (text, fileName) => {
    const tmp = path.join(dir, ".check-test-" + fileName);
    fs.writeFileSync(tmp, text);
    try {
      const out = execFileSync("python3", ["-c", Core.PROFILE_INFO_PY, path.join(SKILL, "scripts"), tmp], { encoding: "utf8" });
      return JSON.parse(out.trim().split("\n").pop());
    }
    finally { fs.rmSync(tmp, { force: true }); }
  };
}

(async () => {
  await test("core: profile file names and menu model", () => {
    assert(Core.isProfileFile("myfield.yaml") && Core.isProfileFile("x.yml"));
    assert(!Core.isProfileFile(".check-ab-myfield.yaml") && !Core.isProfileFile("notes.txt"));
    assert.strictEqual(Core.profileName("/a/b/robotics.yaml"), "robotics");
    assert(Core.validProfileName("myfield-short") && !Core.validProfileName("a b") && !Core.validProfileName("../x") && !Core.validProfileName(""));
    const profiles = ["myfield", "default", "robotics", "template"].map((n) => ({ name: n, path: `/p/${n}.yaml` }));
    const m = Core.profileMenuModel({ profiles, defaultPath: "/p/myfield.yaml", slots: 3 });
    assert.strictEqual(m.items[0].label, "Default profile (myfield)");
    assert.strictEqual(m.items[0].path, null);
    assert.deepStrictEqual(m.items.slice(1).map((i) => i.label), ["myfield  (default)", "default", "robotics"]);
    assert.strictEqual(m.hidden, 1);
    const m2 = Core.profileMenuModel({ profiles: profiles.slice(0, 1), defaultPath: "/p/myfield.yaml", slots: 3 });
    assert.deepStrictEqual(m2.items.slice(1).map((i) => i.visible), [true, false, false]);
  });

  await test("python check: myfield has natural style, 6 sections and 11 checks with their source file", async () => {
    const info = await pyCheck(path.join(SKILL, "profiles"))(fs.readFileSync(path.join(__dirname, "fixtures/myfield.yaml"), "utf8"), "myfield.yaml");
    assert(info.ok, info.error);
    assert.strictEqual(info.style, "natural academic English");
    assert.strictEqual(info.sections.length, 6);
    assert.deepStrictEqual(info.chain.slice(1), ["robotics.yaml", "default.yaml"]);
    const by = Object.fromEntries(info.checks.map((c) => [c.id, c.from]));
    assert.strictEqual(info.checks.length, 11);
    assert.strictEqual(by.sim_vs_real, "robotics.yaml");
    assert.strictEqual(by.claims_vs_tables, "default.yaml");
    assert.strictEqual(by.statistics, "robotics.yaml");
    assert(info.checks[info.checks.length - 1].id === "improvements" && /\.check-test-myfield/.test(by.improvements));
  });

  await test("python check: broken YAML and a check without ask are errors", async () => {
    const chk = pyCheck(path.join(SKILL, "profiles"));
    const bad = await chk("extends: default.yaml\nchecks:\n  - id: x\n   title: wrong indent\n", "bad.yaml");
    assert(!bad.ok && /YAML|Error|expected/i.test(bad.error), bad.error);
    const noask = await chk("extends: default.yaml\nchecks:\n  - id: x\n    title: T\n", "noask.yaml");
    assert(!noask.ok && /ask/.test(noask.error));
    const missingParent = await chk("extends: nothere.yaml\n", "m.yaml");
    assert(!missingParent.ok && /nothere/.test(missingParent.error));
  });

  let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch (e) { console.log("skip - editor tests (jsdom not installed)"); }
  if (JSDOM) {
    await test("editor: list, edit, check, save, new, duplicate, delete rules, default", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-"));
      for (const f of ["default.yaml", "robotics.yaml", "template.yaml"]) fs.copyFileSync(path.join(SKILL, "profiles", f), path.join(dir, f));
      fs.copyFileSync(path.join(__dirname, "fixtures/myfield.yaml"), path.join(dir, "myfield.yaml"));
      const html = `<select id="cr-edit-picker"></select><button id="cr-new"></button><button id="cr-dup"></button><button id="cr-del"></button>
        <button id="cr-default"></button><textarea id="cr-yaml"></textarea><button id="cr-insert-check"></button><button id="cr-insert-style"></button>
        <span id="cr-status"></span><button id="cr-check"></button><button id="cr-save"></button><pre id="cr-info"></pre>`;
      const doc = new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
      let def = path.join(dir, "myfield.yaml"), answers = [], confirms = [], changed = 0;
      const ed = createProfileEditor({
        document: doc, Core,
        io: {
          list: async () => fs.readdirSync(dir).filter((f) => Core.isProfileFile(f)).sort().map((f) => ({ name: Core.profileName(f), path: path.join(dir, f) })),
          read: async (p) => fs.readFileSync(p, "utf8"), write: async (p, t) => fs.writeFileSync(p, t),
          remove: async (p) => fs.rmSync(p), join: (n) => path.join(dir, n),
        },
        check: pyCheck(dir),
        ui: { prompt: () => answers.shift() ?? null, confirm: () => confirms.shift() ?? false },
        prefs: { getDefault: () => def, setDefault: (p) => { def = p; } },
        onChanged: () => changed++,
      });
      const $ = (id) => doc.getElementById(id);
      await ed.refresh();
      const opts = () => [...$("cr-edit-picker").options].map((o) => o.textContent);
      assert.deepStrictEqual(opts(), ["default", "myfield  (default)", "robotics", "template"]);
      assert.strictEqual(ed.current, def, "the default profile opens first");
      assert($("cr-yaml").value.includes("How to improve:"));

      // Check shows the effective checks with their source
      await ed.check();
      assert($("cr-info").textContent.includes("Checks Claude does on every paper (11)"));
      assert($("cr-info").textContent.includes("Simulation against real robot   [sim_vs_real, from robotics.yaml]"));
      assert($("cr-info").textContent.includes("What can be improved   [improvements, from myfield.yaml]"));
      assert($("cr-info").textContent.includes("Style: natural academic English"));

      // An invalid edit is not saved
      const good = $("cr-yaml").value;
      $("cr-yaml").value = good + "\nchecks:\n  - id: broken\n    title: no ask\n";
      assert.strictEqual(await ed.save(), false);
      assert.strictEqual(fs.readFileSync(def, "utf8"), good, "file unchanged");
      assert.match($("cr-status").textContent, /error/);

      // Switching away with unsaved changes asks; "no" keeps the editor
      $("cr-edit-picker").value = path.join(dir, "robotics.yaml");
      confirms.push(false); await ed.select();
      assert.strictEqual(ed.current, def);

      // A valid edit is saved
      $("cr-yaml").value = good;
      $("cr-yaml").selectionStart = $("cr-yaml").selectionEnd = good.length;
      ed.insert("check");
      $("cr-yaml").value = $("cr-yaml").value.replace("id: my_check", "id: ethics").replace("Title of the check (a sub-heading in Detailed comments)", "Ethics and safety");
      assert.strictEqual(await ed.save(), true);
      assert(fs.readFileSync(def, "utf8").includes("id: ethics"));
      assert($("cr-info").textContent.includes("(12)"));

      // New from the template
      answers.push("my field"); await ed.create();
      assert.match($("cr-status").textContent, /letters, digits/);
      answers.push("vision"); await ed.create();
      assert(fs.existsSync(path.join(dir, "vision.yaml")));
      assert(/^name: vision$/m.test(fs.readFileSync(path.join(dir, "vision.yaml"), "utf8")));
      assert.strictEqual(ed.current, path.join(dir, "vision.yaml"));
      answers.push("vision"); await ed.create();
      assert.match($("cr-status").textContent, /already exists/);

      // Duplicate
      $("cr-edit-picker").value = def; await ed.select();
      answers.push("myfield-short"); await ed.duplicate();
      const dup = fs.readFileSync(path.join(dir, "myfield-short.yaml"), "utf8");
      assert(/^name: myfield-short$/m.test(dup) && dup.includes("extends: robotics.yaml"));

      // Delete rules
      $("cr-edit-picker").value = path.join(dir, "robotics.yaml"); await ed.select();
      await ed.remove();
      assert.match($("cr-status").textContent, /cannot be deleted: (myfield, myfield-short|myfield-short, myfield) extends it/);
      $("cr-edit-picker").value = path.join(dir, "default.yaml"); await ed.select();
      await ed.remove();
      assert.match($("cr-status").textContent, /base of the other profiles/);
      $("cr-edit-picker").value = path.join(dir, "vision.yaml"); await ed.select();
      confirms.push(false); await ed.remove();
      assert(fs.existsSync(path.join(dir, "vision.yaml")), "kept when you answer no");
      confirms.push(true); await ed.remove();
      assert(!fs.existsSync(path.join(dir, "vision.yaml")));

      // Use as default
      $("cr-edit-picker").value = path.join(dir, "myfield-short.yaml"); await ed.select();
      await ed.makeDefault();
      assert.strictEqual(def, path.join(dir, "myfield-short.yaml"));
      assert(opts().includes("myfield-short  (default)"));
      assert(!fs.readdirSync(dir).some((f) => f.startsWith(".check")), "no temp files left");
      assert(changed > 0);
    });
  }

  await test("queue: each paper keeps its own profile, the engine gets it, the panel shows it", async () => {
    const got = [];
    const engine = { review: async (item, opts) => { got.push([item.id, opts.profilePath]); return { annotations: 1 }; } };
    const q = createReviewQueue({ engine, getItem: async (id) => ({ id }), titleOf: (it) => "P" + it.id });
    q.add([{ id: 1 }], { profilePath: null, profileName: "myfield" });
    q.add([{ id: 2 }], { profilePath: "/p/robotics.yaml", profileName: "robotics" });
    q.add([{ id: 1 }], { profilePath: "/p/robotics.yaml", profileName: "robotics" }); // already active: not added
    await q.idle(); await tick(20);
    assert.deepStrictEqual(got, [[1, undefined], [2, "/p/robotics.yaml"]]);
    assert.deepStrictEqual(q.jobs.map((j) => j.profileName), ["myfield", "robotics"]);
    if (JSDOM) {
      const doc = new JSDOM("<!DOCTYPE html><body></body>").window.document;
      const panel = createQueuePanel({ document: doc, queue: q, setTimer: (f, m) => setTimeout(f, m), clearTimer: clearTimeout });
      panel.show();
      const labels = [...doc.querySelectorAll("[data-role=profile]")].map((e) => e.textContent);
      assert.deepStrictEqual(labels, ["profile: myfield", "profile: robotics"]);
      panel.destroy();
    }
  });

  console.log(`\n${passed} tests passed (no real Zotero, no real claude)`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
