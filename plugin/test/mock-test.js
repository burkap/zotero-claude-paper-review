// Tests the JSON -> Zotero mapping and the run flow with a MOCKED Zotero.
// Zotero itself is not started. `claude` is replaced by a fake Subprocess that copies
// the real STAR test output (examples/star-paper) into OUT, so the data is real.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const Core = require("../lib/review-core.js");
const create = require("../lib/claude-review.js");

const STAR_OUT = path.resolve(__dirname, "../../examples/star-paper");
const profilesDir = path.resolve(__dirname, "../../skill/paper-review/profiles");

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

// ---- mocks -------------------------------------------------------------
const PathUtils = {
  tempDir: os.tmpdir(),
  join: (...p) => path.join(...p),
  parent: (p) => path.dirname(p),
  filename: (p) => path.basename(p),
};
const IOUtils = {
  exists: async (p) => fs.existsSync(p),
  makeDirectory: async (p) => fs.mkdirSync(p, { recursive: true }),
  copy: async (a, b) => fs.copyFileSync(a, b),
  getChildren: async (d) => fs.readdirSync(d).map((f) => path.join(d, f)),
  readUTF8: async (p) => fs.readFileSync(p, "utf8"),
  remove: async (p) => fs.rmSync(p, { recursive: true, force: true }),
};

function makeZotero() {
  const Z = { log: [], saved: [], erased: [], notes: [], attachmentsImported: [], progress: [] };
  Z.Prefs = {
    vals: {
      "extensions.claude-review.claudePath": "/fake/bin/claude",
      "extensions.claude-review.skillDir": "/fake/skill",
      "extensions.claude-review.profilePath": path.join(profilesDir, "robotics.yaml"),
      "extensions.claude-review.pythonDir": "/fake/py",
      "extensions.claude-review.extraPath": "",
      "extensions.claude-review.model": "",
      "extensions.claude-review.timeoutSec": 60,
      "extensions.claude-review.maxTurns": 80,
      "extensions.claude-review.attachPdf": true,
    },
    get(k, g) { assert.strictEqual(g, true, "prefs are read as global names"); return this.vals[k]; },
  };
  Z.Utilities = { randomString: (n) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, "x") };
  Z.Promise = { delay: (ms) => new Promise((r) => setTimeout(r, ms)) };
  Z.logError = (e) => Z.log.push(String(e));
  Z.debug = () => {};
  Z.DataObjectUtilities = { generateKey: () => Array.from({ length: 8 }, () => "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 33)]).join("") };
  Z.Libraries = { get: () => ({ libraryType: "user" }) };
  Z.ProgressWindow = function () {
    this.changeHeadline = (t) => Z.progress.push("headline:" + t);
    this.show = () => Z.progress.push("show");
    this.startCloseTimer = () => {};
    this.ItemProgress = function () { return { setText: (t) => Z.progress.push(t), setProgress() {}, setError: () => Z.progress.push("ERROR") }; };
  };
  // Annotations.saveFromJSON mock: enforces the same checks as Zotero 10.0.6 item.js
  Z.Annotations = {
    async saveFromJSON(attachment, json) {
      assert(json.key, "'key' not provided in JSON");
      assert(["highlight", "underline"].includes(json.type));
      assert(/^\d{5}\|\d{6}\|\d{5}$/.test(json.sortIndex), "sortIndex format");
      assert(json.color.match(/#[a-f0-9]{6}/), "color");
      assert.strictEqual(typeof json.position, "object");
      JSON.stringify(Object.assign({}, json.position)); // as the real function does
      assert(json.tags.some((t) => t.name === "claude-review"));
      Z.saved.push(json);
      let a = mkItem({ id: 1000 + Z.saved.length, tags: ["claude-review"], key: json.key });
      attachment._anns.push(a);
    },
  };
  Z.Attachments = {
    async importFromFile(o) { Z.attachmentsImported.push(o); return mkItem({ id: 5000, tags: [] }); },
  };
  Z.Items = { getAsync: async (id) => Z._byId[id] };
  Z._byId = {};
  Z.Item = function (type) {
    assert.strictEqual(type, "note");
    let it = mkItem({ id: 9000 + Z.notes.length, tags: [] });
    it.setNote = (h) => { it.html = h; };
    it.saveTx = async () => { assert(it.parentID); Z.notes.push(it); };
    return it;
  };
  function mkItem({ id, tags, key }) {
    let it = { id, key: key || "ITEM" + id, libraryID: 1, tags: [...tags],
      hasTag(t) { return this.tags.includes(t); }, addTag(t) { this.tags.push(t); },
      saveTx: async () => {}, eraseTx: async () => { Z.erased.push(it.id); }, loadAllData: async () => {} };
    Z._byId[id] = it;
    return it;
  }
  Z.mkItem = mkItem;
  return Z;
}

function makeFixture(Z) {
  const pdfFile = path.join(os.tmpdir(), "mock-paper.pdf");
  fs.writeFileSync(pdfFile, "%PDF-1.4 fake");
  const att = Z.mkItem({ id: 10, tags: [], key: "ATTKEY01" });
  att.isAttachment = () => true; att.isPDFAttachment = () => true; att.parentItemID = 20;
  att.getFilePathAsync = async () => pdfFile; att._anns = [];
  att.getAnnotations = () => att._anns;
  // an old annotation made by us, and one made by the user
  const oldOurs = Z.mkItem({ id: 11, tags: ["claude-review"] });
  const userAnn = Z.mkItem({ id: 12, tags: [] });
  att._anns.push(oldOurs, userAnn);
  const oldNote = Z.mkItem({ id: 13, tags: ["claude-review"] });
  const userNote = Z.mkItem({ id: 14, tags: [] });
  const parent = Z.mkItem({ id: 20, tags: [], key: "PARENT01" });
  parent.isAttachment = () => false; parent.isRegularItem = () => true;
  parent.getNotes = () => [13, 14]; parent.getAttachments = () => [10];
  parent.getBestAttachments = async () => [att];
  return { att, parent, oldOurs, userAnn, oldNote, userNote };
}

function makeSubprocess(calls, { fail } = {}) {
  return { async call(opts) {
    calls.push(opts);
    const out = opts.arguments[opts.arguments.indexOf("-p") + 1].match(/OUT=(\S+?)\./)[1].replace(/\.$/, "");
    const outDir = opts.arguments[1].match(/OUT=(.*?)\. Run/)[1];
    if (!fail) for (const f of ["result.json", "annotations.json", "note.html", "review.pdf"]) fs.copyFileSync(path.join(STAR_OUT, f), path.join(outDir, f));
    const json = JSON.stringify(fail ? { type: "result", is_error: true, result: "Not logged in" } : { type: "result", is_error: false, result: "done", total_cost_usd: 0 });
    const mkPipe = (s) => { let sent = false; return { readString: async () => { if (sent) return ""; sent = true; return s; } }; };
    return { stdout: mkPipe(json), stderr: mkPipe(""), wait: async () => ({ exitCode: fail ? 1 : 0 }), kill: async () => {} };
  } };
}

(async () => {
  await test("core: environment removes API key and cloud vars, keeps a usable PATH", () => {
    const env = Core.buildEnvironment({ inheritedPath: "/a:/b", extraDirs: ["/fake/bin", "/fake/py"] });
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) assert.strictEqual(env[k], null, k);
    assert(env.PATH.startsWith("/fake/bin:/fake/py"));
    assert(env.PATH.includes("/opt/homebrew/bin") && env.PATH.includes("/a:/b"));
  });

  await test("core: args use -p, json output, limited tools, no prompts", () => {
    const a = Core.buildArgs({ prompt: "P", model: "opus", maxTurns: 50 });
    assert.deepStrictEqual(a.slice(0, 4), ["-p", "P", "--output-format", "json"]);
    assert(a.includes("--allowedTools") && a.includes("--permission-mode") && a[a.indexOf("--permission-mode") + 1] === "dontAsk");
    assert(a[a.indexOf("--allowedTools") + 1].split(",").every((t) => /^(Read|Write|Edit|Bash\((python3|python|ls|mkdir|cat|echo|test) \*\))$/.test(t)));
    assert(a.includes("--max-turns") && a.includes("--model"));
    assert(!a.includes("--dangerously-skip-permissions"));
    assert(!Core.buildArgs({ prompt: "P", model: "default", maxTurns: 5 }).includes("--model"), "default means no --model");
  });

  await test("core: every annotation of the real STAR output maps to a valid saveFromJSON input", () => {
    const anns = JSON.parse(fs.readFileSync(path.join(STAR_OUT, "annotations.json"))).annotations;
    assert.strictEqual(anns.length, 39);
    for (const a of anns) {
      const j = Core.mapAnnotation(a, "ABCD1234");
      assert.strictEqual(j.type, "highlight");
      assert(j.comment.startsWith(`[${a.tag}] `));
      assert.strictEqual(j.position.pageIndex, a.pageNumber - 1);
      assert(j.position.rects.every((r) => r.length === 4 && r[0] < r[2] && r[1] < r[3]));
    }
  });

  await test("core: bad annotations are rejected", () => {
    const a = JSON.parse(fs.readFileSync(path.join(STAR_OUT, "annotations.json"))).annotations[0];
    assert.throws(() => Core.mapAnnotation({ ...a, annotationSortIndex: "1|2|3" }, "K"), /sortIndex/);
    assert.throws(() => Core.mapAnnotation({ ...a, annotationColor: "red" }, "K"), /color/);
    assert.throws(() => Core.mapAnnotation({ ...a, annotationPosition: { pageIndex: 0, rects: [] } }, "K"), /position/);
    assert.throws(() => Core.mapAnnotation({ ...a, annotationType: "note" }, "K"), /highlight/);
  });

  await test("core: link format and note rewriting", () => {
    assert.strictEqual(Core.annotationUrl({ groupID: null, attachmentKey: "AAA", page: 7, annotationKey: "BBB" }), "zotero://open-pdf/library/items/AAA?page=7&annotation=BBB");
    assert.strictEqual(Core.annotationUrl({ groupID: 55, attachmentKey: "AAA", page: 7, annotationKey: "BBB" }), "zotero://open-pdf/groups/55/items/AAA?page=7&annotation=BBB");
    assert.throws(() => Core.rewriteNoteLinks('<a href="zotero-ev://W9">', {}), /W9/);
  });

  await test("core: claude JSON parsing", () => {
    assert.strictEqual(Core.parseClaudeJson('{"result":"x","is_error":false}').result, "x");
    assert.strictEqual(Core.parseClaudeJson('noise\n{"result":"y"}').result, "y");
    assert.throws(() => Core.parseClaudeJson("not json"), /did not print JSON/);
    const nd = '{"type":"system","subtype":"init"}\n{"type":"result","is_error":true,"result":"R"}\n{"type":"system","subtype":"task_summary"}\n';
    assert.strictEqual(Core.parseClaudeJson(nd).result, "R"); // result line is not the last line
  });

  await test("flow: full run writes 39 annotations, one note with working links, review PDF, replaces old items", async () => {
    const Z = makeZotero(); const fx = makeFixture(Z); const calls = [];
    const engine = create({ Zotero: Z, IOUtils, PathUtils, Subprocess: makeSubprocess(calls), Core, homeDir: "/home/x", platformEnv: { PATH: "/usr/bin" } });
    // skill dir must "exist": point it to the real skill folder
    Z.Prefs.vals["extensions.claude-review.skillDir"] = path.resolve(__dirname, "../../skill/paper-review");
    Z.Prefs.vals["extensions.claude-review.claudePath"] = process.execPath; // any existing file
    const res = await engine.review(fx.parent);
    assert.strictEqual(res.annotations, 39);
    assert.strictEqual(Z.saved.length, 39);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].environment.ANTHROPIC_API_KEY, null);
    assert.strictEqual(calls[0].environmentAppend, true);
    assert(calls[0].arguments[1].startsWith("/paper-review "));
    assert(fs.existsSync(path.join(calls[0].workdir)) === false, "temp folder cleaned up");
    assert.strictEqual(Z.notes.length, 1);
    const html = Z.notes[0].html;
    assert(!html.includes("zotero-ev://"));
    const m = [...html.matchAll(/href="(zotero:\/\/open-pdf\/library\/items\/ATTKEY01\?page=(\d+)&annotation=([A-Z0-9]{8}))"/g)];
    assert(m.length > 39, "every tag mention is a link: " + m.length);
    const keys = new Set(Z.saved.map((s) => s.key));
    assert(m.every((x) => keys.has(x[3])), "each link points to a saved annotation key");
    assert.strictEqual(Z.notes[0].parentID, 20);
    assert(Z.notes[0].hasTag("claude-review"));
    assert.strictEqual(Z.attachmentsImported.length, 1);
    assert.deepStrictEqual(Z.erased.sort(), [11, 13].sort(), "only old claude-review items are erased");
    assert(!Z.erased.includes(12) && !Z.erased.includes(14), "user items are kept");
    assert(Z.progress.some((l) => l.startsWith("Done: 39")));
  });

  await test("flow: claude error is reported and nothing is written or erased", async () => {
    const Z = makeZotero(); const fx = makeFixture(Z); const calls = [];
    const engine = create({ Zotero: Z, IOUtils, PathUtils, Subprocess: makeSubprocess(calls, { fail: true }), Core, homeDir: "/home/x", platformEnv: { PATH: "" } });
    Z.Prefs.vals["extensions.claude-review.skillDir"] = path.resolve(__dirname, "../../skill/paper-review");
    Z.Prefs.vals["extensions.claude-review.claudePath"] = process.execPath;
    await assert.rejects(() => engine.review(fx.parent), /Not logged in/);
    assert.strictEqual(Z.saved.length, 0); assert.strictEqual(Z.erased.length, 0); assert.strictEqual(Z.notes.length, 0);
    assert(Z.progress.includes("ERROR"));
  });

  await test("flow: item without PDF, and review-PDF attachments are skipped as source", async () => {
    const Z = makeZotero(); const fx = makeFixture(Z);
    const engine = create({ Zotero: Z, IOUtils, PathUtils, Subprocess: {}, Core, homeDir: "/h", platformEnv: {} });
    fx.parent.getBestAttachments = async () => [];
    await assert.rejects(() => engine.resolveTargets(fx.parent), /no PDF/);
    const ours = Z.mkItem({ id: 77, tags: ["claude-review"] }); ours.isPDFAttachment = () => true;
    fx.parent.getBestAttachments = async () => [ours, fx.att];
    assert.strictEqual((await engine.resolveTargets(fx.parent)).attachment.id, 10);
  });

  await test("core: stream lines are summarised for the live log", () => {
    const L = (o) => Core.summarizeStreamLine(o);
    assert.deepStrictEqual(L({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python3 /x/locate_quotes.py a b c" } }] } }), [{ kind: "tool", text: "Bash: python3 /x/locate_quotes.py a b c" }]);
    assert.strictEqual(L({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/t/out/paper.txt", pages: "1-5" } }] } })[0].text, "Read: paper.txt pages 1-5");
    assert.strictEqual(L({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } })[0].kind, "err");
    assert.deepStrictEqual(L({ type: "system", subtype: "init" }), []);
    assert.deepStrictEqual(L(null), []);
    const a = Core.buildArgs({ prompt: "P", stream: true });
    assert(a.includes("stream-json") && a.includes("--verbose"));
  });

  await test("flow: live log window gets tool lines, status, and the run still succeeds", async () => {
    const Z = makeZotero(); const fx = makeFixture(Z); const lines = []; let status = [];
    const logWin = { append: (t, k) => lines.push(k + ":" + t), setStatus: (t) => status.push(t), setCancel() {}, finish() {} };
    const sp = { async call(opts) {
      assert(opts.arguments.includes("stream-json") && opts.arguments.includes("--verbose"));
      const outDir = opts.arguments[1].match(/OUT=(.*?)\. Run/)[1];
      for (const f of ["result.json", "annotations.json", "note.html", "review.pdf"]) fs.copyFileSync(path.join(STAR_OUT, f), path.join(outDir, f));
      const ndjson = [
        { type: "system", subtype: "init" },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: outDir + "/paper.txt" } }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Applying the statistics check" }] } },
        { type: "result", subtype: "success", is_error: false, result: "done" },
      ].map((o) => JSON.stringify(o)).join("\n") + "\n";
      // deliver in two chunks that split a line in the middle
      const half = Math.floor(ndjson.length / 2); let parts = [ndjson.slice(0, half), ndjson.slice(half)];
      return { stdout: { readString: async () => parts.shift() || "" }, stderr: { readString: async () => "" }, wait: async () => ({ exitCode: 0 }), kill: async () => {} };
    } };
    const engine = create({ Zotero: Z, IOUtils, PathUtils, Subprocess: sp, Core, homeDir: "/h", platformEnv: { PATH: "" }, openLog: async () => logWin });
    Z.Prefs.vals["extensions.claude-review.skillDir"] = path.resolve(__dirname, "../../skill/paper-review");
    Z.Prefs.vals["extensions.claude-review.claudePath"] = process.execPath;
    Z.Prefs.vals["extensions.claude-review.liveLog"] = true;
    await engine.review(fx.parent);
    assert(lines.includes("tool:Read: paper.txt"), JSON.stringify(lines));
    assert(lines.includes("text:Applying the statistics check"));
    assert(lines.includes("file:Done."));
    assert.strictEqual(Z.saved.length, 39);
  });

  await test("flow: Cancel button kills the process and nothing is written", async () => {
    const Z = makeZotero(); const fx = makeFixture(Z); let cancel, killed = false, release;
    const logWin = { append() {}, setStatus() {}, setCancel: (fn) => { cancel = fn; }, finish() {} };
    const sp = { async call() {
      const waiting = new Promise((r) => { release = r; });
      return { stdout: { readString: async () => { await waiting; return ""; } }, stderr: { readString: async () => "" },
        wait: async () => { await waiting; return { exitCode: 143 }; }, kill: async () => { killed = true; release(); } };
    } };
    const engine = create({ Zotero: Z, IOUtils, PathUtils, Subprocess: sp, Core, homeDir: "/h", platformEnv: { PATH: "" }, openLog: async () => logWin });
    Z.Prefs.vals["extensions.claude-review.skillDir"] = path.resolve(__dirname, "../../skill/paper-review");
    Z.Prefs.vals["extensions.claude-review.claudePath"] = process.execPath;
    const p = engine.review(fx.parent);
    await new Promise((r) => setTimeout(r, 300));
    cancel();
    await assert.rejects(() => p, /Cancelled/);
    assert(killed && Z.saved.length === 0 && Z.erased.length === 0);
  });

  console.log(`\n${passed} tests passed (mocked Zotero; real Zotero and real claude not run)`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
