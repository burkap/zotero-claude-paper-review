// Tests the review queue and the queue panel. Zotero is not started.
// The queue uses a fake engine; one test also runs the real engine with mocked Zotero (as in mock-test.js).
// The panel test needs jsdom: NODE_PATH=<dir with jsdom> node test/queue-test.js (it is skipped without jsdom).
const assert = require("assert");
const createReviewQueue = require("../lib/review-queue.js");
const createQueuePanel = require("../lib/queue-panel.js");

let passed = 0, skipped = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Fake engine: each review waits until the test calls finish(id) or fail(id), or is cancelled.
function fakeEngine() {
  const runs = new Map(); const order = [];
  return {
    order, runs,
    async review(item, { ctx }) {
      order.push(item.id);
      ctx.ui.set("Step 1/5: text extracted (0:03)", 30);
      ctx.log.append("Read: paper.txt", "tool");
      return new Promise((resolve, reject) => {
        ctx.kill = () => { ctx.cancelled = true; reject(new Error("Cancelled by you.")); };
        runs.set(item.id, { ok: () => resolve({ annotations: 40, noteID: 900 + item.id }), bad: (m) => reject(new Error(m)), ctx });
      });
    },
  };
}
const items = (...ids) => ids.map((id) => ({ id }));
function mkQueue(engine) {
  return createReviewQueue({ engine, getItem: async (id) => ({ id }), titleOf: (it) => "Paper " + it.id });
}
const states = (q) => q.jobs.map((j) => `${j.itemID}:${j.state}`).join(" ");

(async () => {
  await test("queue: papers run one at a time, in order", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2, 3)); await tick();
    assert.strictEqual(states(q), "1:running 2:waiting 3:waiting");
    assert.strictEqual(q.jobs[0].step, "Step 1/5: text extracted", "the clock is removed from the step text");
    e.runs.get(1).ok(); await tick();
    assert.strictEqual(states(q), "1:done 2:running 3:waiting");
    e.runs.get(2).ok(); await tick(); e.runs.get(3).ok(); await tick();
    assert.strictEqual(states(q), "1:done 2:done 3:done");
    assert.deepStrictEqual(e.order, [1, 2, 3]);
    assert.strictEqual(q.jobs[0].result.noteID, 901);
  });

  await test("queue: the same paper is not added twice while it is active", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2)); await tick();
    assert.deepStrictEqual(q.add(items(1, 2, 3)), { added: 1, skipped: 2 });
    e.runs.get(1).ok(); await tick();
    assert.deepStrictEqual(q.add(items(1)), { added: 1, skipped: 0 }, "a done paper can be queued again");
  });

  await test("queue: Pause lets the running paper finish, then nothing starts until Resume", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2)); await tick();
    q.pause();
    assert.strictEqual(q.jobs[0].state, "running", "pause does not stop the running paper");
    e.runs.get(1).ok(); await tick(20);
    assert.strictEqual(states(q), "1:done 2:waiting");
    q.add(items(3)); await tick();
    assert.strictEqual(states(q), "1:done 2:waiting 3:waiting", "adding while paused does not start");
    q.resume(); await tick();
    assert.strictEqual(states(q), "1:done 2:running 3:waiting");
  });

  await test("queue: a paused (held) paper is skipped, and runs after you resume it", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2, 3)); await tick();
    q.hold(q.jobs[1].id);
    e.runs.get(1).ok(); await tick();
    assert.strictEqual(states(q), "1:done 2:held 3:running");
    q.release(q.jobs[1].id);
    e.runs.get(3).ok(); await tick();
    assert.strictEqual(states(q), "1:done 2:running 3:done");
  });

  await test("queue: Cancel stops the running paper, the next one starts", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2)); await tick();
    q.cancel(q.jobs[0].id); await tick();
    assert.strictEqual(states(q), "1:cancelled 2:running");
    assert.strictEqual(q.jobs[0].error, "Cancelled by you.");
  });

  await test("queue: Cancel is refused while Zotero is saving the result", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1)); await tick();
    e.runs.get(1).ctx.writing = true;
    q.cancel(q.jobs[0].id); await tick();
    assert.strictEqual(q.jobs[0].state, "running");
    e.runs.get(1).ok(); await tick();
    assert.strictEqual(q.jobs[0].state, "done");
  });

  await test("queue: a failure does not stop the queue, and Retry puts the paper back at the end", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2)); await tick();
    e.runs.get(1).bad("Claude did not finish in 1200 s."); await tick();
    assert.strictEqual(states(q), "1:failed 2:running");
    assert.match(q.jobs[0].error, /did not finish/);
    q.retry(q.jobs[0].id);
    assert.strictEqual(states(q), "2:running 1:waiting");
    e.runs.get(2).ok(); await tick();
    assert.strictEqual(states(q), "2:done 1:running");
  });

  await test("queue: move up/down only among papers that did not start", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2, 3, 4)); await tick();
    q.move(q.jobs[3].id, -1); // 4 up
    assert.strictEqual(states(q), "1:running 2:waiting 4:waiting 3:waiting");
    q.move(q.jobs[1].id, -1); // 2 up: nothing above it that did not start
    assert.strictEqual(states(q), "1:running 2:waiting 4:waiting 3:waiting");
    q.move(q.jobs[0].id, +1); // the running paper cannot move
    assert.strictEqual(states(q), "1:running 2:waiting 4:waiting 3:waiting");
  });

  await test("queue: clear waiting, clear finished, remove", async () => {
    const e = fakeEngine(); const q = mkQueue(e);
    q.add(items(1, 2, 3)); await tick();
    q.clearWaiting();
    assert.strictEqual(states(q), "1:running 2:cancelled 3:cancelled");
    e.runs.get(1).ok(); await tick();
    q.clearFinished();
    assert.strictEqual(q.jobs.length, 0);
  });

  await test("queue: a missing item fails that job only", async () => {
    const e = fakeEngine();
    const q = createReviewQueue({ engine: e, getItem: async (id) => (id === 1 ? null : { id }), titleOf: (it) => "P" + it.id });
    q.add(items(1, 2)); await tick();
    assert.strictEqual(states(q), "1:failed 2:running");
  });

  // Real engine (mocked Zotero) through the queue: two papers, the second waits for the first.
  await test("queue + real engine: two papers in sequence, no shared state", async () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const Core = require("../lib/review-core.js");
    const create = require("../lib/claude-review.js");
    const STAR_OUT = path.resolve(__dirname, "../../examples/star-paper");
    const vals = {
      "extensions.claude-review.claudePath": process.execPath,
      "extensions.claude-review.skillDir": path.resolve(__dirname, "../../skill/paper-review"),
      "extensions.claude-review.profilePath": path.resolve(__dirname, "../../skill/paper-review/profiles/robotics.yaml"),
      "extensions.claude-review.timeoutSec": 60, "extensions.claude-review.maxTurns": 80, "extensions.claude-review.liveLog": true,
    };
    let saved = 0, notes = [], byId = {}, live = 0, maxLive = 0;
    const mk = (id, key) => { const it = { id, key, libraryID: 1, tags: [], hasTag(t) { return this.tags.includes(t); }, addTag(t) { this.tags.push(t); }, loadAllData: async () => {}, eraseTx: async () => {} }; byId[id] = it; return it; };
    const Z = {
      Prefs: { get: (k) => vals[k] }, Utilities: { randomString: () => Math.random().toString(36).slice(2, 10) },
      Promise: { delay: (ms) => new Promise((r) => setTimeout(r, ms)) }, logError() {}, debug() {},
      DataObjectUtilities: { generateKey: () => Math.random().toString(36).slice(2, 10).toUpperCase() },
      Libraries: { get: () => ({ libraryType: "user" }) },
      Annotations: { saveFromJSON: async () => { saved++; } },
      Attachments: { importFromFile: async () => mk(5000, "R") },
      Items: { getAsync: async (id) => byId[id] },
      Item: function () { const n = mk(9000 + notes.length, "N"); n.setNote = (h) => { n.html = h; }; n.saveTx = async () => { notes.push(n); }; return n; },
      ProgressWindow: function () { throw new Error("the queue must not open progress windows"); },
    };
    const pdf = path.join(os.tmpdir(), "q-paper.pdf"); fs.writeFileSync(pdf, "%PDF fake");
    for (const pid of [20, 30]) {
      const att = mk(pid + 1, "ATT" + pid); att.isAttachment = () => true; att.isPDFAttachment = () => true;
      att.parentItemID = pid; att.getFilePathAsync = async () => pdf; att.getAnnotations = () => [];
      const p = mk(pid, "P" + pid); p.isAttachment = () => false; p.isRegularItem = () => true;
      p.getNotes = () => []; p.getAttachments = () => [pid + 1]; p.getBestAttachments = async () => [att];
    }
    const sp = { async call(opts) {
      live++; maxLive = Math.max(maxLive, live);
      const outDir = opts.arguments[1].match(/OUT=(.*?)\. Run/)[1];
      await new Promise((r) => setTimeout(r, 50));
      for (const f of ["result.json", "annotations.json", "note.html", "review.pdf"]) fs.copyFileSync(path.join(STAR_OUT, f), path.join(outDir, f));
      const line = JSON.stringify({ type: "result", is_error: false, result: "done" }) + "\n";
      let sent = false;
      return { stdout: { readString: async () => (sent ? "" : (sent = true, line)) }, stderr: { readString: async () => "" },
        wait: async () => { live--; return { exitCode: 0 }; }, kill: async () => {} };
    } };
    const PathUtils = { tempDir: os.tmpdir(), join: (...p) => path.join(...p), parent: path.dirname, filename: path.basename };
    const IOUtils = { exists: async (p) => fs.existsSync(p), makeDirectory: async (p) => fs.mkdirSync(p, { recursive: true }), copy: async (a, b) => fs.copyFileSync(a, b), getChildren: async (d) => fs.readdirSync(d).map((f) => path.join(d, f)), readUTF8: async (p) => fs.readFileSync(p, "utf8"), remove: async (p) => fs.rmSync(p, { recursive: true, force: true }) };
    const engine = create({ Zotero: Z, IOUtils, PathUtils, Subprocess: sp, Core, homeDir: "/h", platformEnv: { PATH: "" } });
    const q = createReviewQueue({ engine, getItem: async (id) => byId[id], titleOf: (it) => "P" + it.id });
    q.add([byId[20], byId[30]]);
    await q.idle(); await tick(20);
    assert.strictEqual(states(q), "20:done 30:done");
    assert.strictEqual(maxLive, 1, "never two claude processes at once");
    assert.strictEqual(saved, 78); assert.strictEqual(notes.length, 2);
    assert.strictEqual(notes[0].parentID, 20); assert.strictEqual(notes[1].parentID, 30);
    assert(q.jobs.every((j) => j.log.length > 0), "each job has its own log");
    assert.strictEqual(q.jobs[1].result.noteID, notes[1].id);
  });

  // Panel
  let JSDOM = null;
  try { ({ JSDOM } = require("jsdom")); } catch (e) { /* not installed */ }
  if (!JSDOM) { skipped++; console.log("skip - panel tests (jsdom not installed)"); }
  else {
    await test("panel: rows, status, buttons per state, pause banner, log of the selected paper", async () => {
      const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
      const doc = dom.window.document;
      const e = fakeEngine(); const q = mkQueue(e);
      let opened = null;
      const panel = createQueuePanel({ document: doc, queue: q, selectItem: (id) => { opened = id; }, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout });
      panel.show();
      const root = () => doc.getElementById("claude-review-queue-panel");
      assert(root().textContent.includes("The queue is empty"));
      q.add(items(1, 2, 3)); await tick();
      q.hold(q.jobs[2].id);
      panel.renderNow();
      const rows = () => [...root().querySelectorAll("tr[data-job]")];
      assert.strictEqual(rows().length, 3);
      const actionsOf = (i) => [...rows()[i].querySelectorAll("button")].map((b) => b.getAttribute("data-action"));
      assert.deepStrictEqual(actionsOf(0), ["cancel"]);
      assert.deepStrictEqual(actionsOf(1), ["up", "down", "hold", "cancel"]);
      assert.deepStrictEqual(actionsOf(2), ["up", "down", "release", "cancel"]);
      assert(rows()[0].textContent.includes("Step 1/5"));
      assert(rows()[2].textContent.includes("Paused by you"));
      assert(root().querySelector("[data-role=log]").textContent.includes("Read: paper.txt"), "log of the running paper is shown");
      assert(root().textContent.includes("1 running · 1 waiting · 1 paused · 0 done"));
      // Pause queue button
      root().querySelector("button[data-action=pause]").click();
      assert(q.isPaused());
      panel.renderNow();
      assert(root().textContent.includes("Queue paused"));
      assert(root().querySelector("button[data-action=resume]"));
      // finish paper 1 -> done row with Open note
      e.runs.get(1).ok(); await tick();
      panel.renderNow();
      assert.deepStrictEqual(actionsOf(0), ["open-note", "remove"]);
      rows()[0].querySelector("button[data-action=open-note]").click();
      assert.strictEqual(opened, 901);
      assert(rows()[0].textContent.includes("Done: 40 highlights"));
      // clicking a row shows its log
      rows()[1].click();
      assert(root().textContent.includes("Log: Paper 2"));
      assert(root().querySelector("[data-role=log]").textContent.includes("Not started yet"));
      // Cancel on a waiting paper via its button
      rows()[1].querySelector("button[data-action=cancel]").click();
      panel.renderNow();
      assert.deepStrictEqual(actionsOf(1), ["retry", "remove"]);
      // hide keeps the queue
      root().querySelector("button[data-action=hide]").click();
      assert.strictEqual(root(), null);
      assert.strictEqual(q.jobs.length, 3);
      panel.show();
      assert(root());
      panel.destroy();
    });

    await test("panel: live updates are drawn without a manual render", async () => {
      const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
      const doc = dom.window.document;
      const e = fakeEngine(); const q = mkQueue(e);
      const panel = createQueuePanel({ document: doc, queue: q, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout });
      panel.show();
      q.add(items(7)); await tick(400);
      assert(doc.getElementById("claude-review-queue-panel").textContent.includes("Paper 7"));
      panel.destroy();
    });
  }

  console.log(`\n${passed} tests passed, ${skipped} skipped (no real Zotero, no real claude)`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
