/* Review queue: one worker, papers are reviewed one after the other.
 * No DOM here, so Node can test it. The panel (queue-panel.js) only reads `jobs` and calls the actions.
 *
 * Job states:
 *   waiting   -> in the queue, starts when it is first and the queue is not paused
 *   held      -> you paused this paper; the worker skips it until you click Resume on it
 *   running   -> Claude is working on it
 *   done | failed | cancelled -> finished
 * "Pause queue" never stops a running paper: the running paper finishes, then nothing new starts. */
var createReviewQueue = function ({ engine, getItem, titleOf, now = () => Date.now(), maxLog = 3000 }) {
  let jobs = [];
  let paused = false;
  let seq = 0;
  let listeners = new Set();
  let pending = null; // promise of the running job (tests wait on it)

  const ACTIVE = ["waiting", "held", "running"];
  const FINISHED = ["done", "failed", "cancelled"];

  function emit() { for (let fn of listeners) { try { fn(); } catch (e) { /* a broken listener must not stop the queue */ } } }
  function find(id) { return jobs.find((j) => j.id === id); }

  function newJob(itemID, title, profile) {
    return { id: ++seq, itemID, title, profilePath: profile.profilePath || null, profileName: profile.profileName || "default", state: "waiting", step: "Waiting", pct: 0,
      addedAt: now(), startedAt: null, endedAt: null, error: null, result: null, log: [], ctx: null };
  }

  // Add papers. A paper that is already waiting, held or running is not added again.
  // profile = { profilePath, profileName }; profilePath null means the default profile at start time.
  function add(items, profile = {}) {
    let added = 0, skipped = 0;
    for (let it of items) {
      if (jobs.some((j) => j.itemID === it.id && ACTIVE.includes(j.state))) { skipped++; continue; }
      jobs.push(newJob(it.id, titleOf(it), profile));
      added++;
    }
    emit();
    pump();
    return { added, skipped };
  }

  function makeCtx(job) {
    let pushLog = (text, kind) => {
      job.log.push({ t: now(), kind: kind || "text", text: String(text) });
      if (job.log.length > maxLog) job.log.splice(0, job.log.length - maxLog);
      emit();
    };
    return {
      cancelled: false, kill: null,
      ui: {
        set(text, pct) { job.step = String(text).replace(/\s*\(\d+:\d\d\)$/, ""); if (pct !== undefined) job.pct = pct; emit(); },
        done(text) { job.step = text; job.pct = 100; emit(); },
        fail(text) { job.step = text; emit(); },
      },
      log: {
        append: pushLog,
        setStatus(text, pct) { if (pct !== undefined) job.pct = pct; },
        setCancel() { /* the queue cancels through ctx.kill */ },
        finish() {},
        setTitle() {},
      },
    };
  }

  async function runJob(job) {
    job.state = "running"; job.startedAt = now(); job.endedAt = null; job.error = null; job.result = null;
    job.pct = 1; job.step = "Starting"; job.log = [];
    job.ctx = makeCtx(job);
    emit();
    try {
      let item = await getItem(job.itemID);
      if (!item) throw new Error("The item is not in the library any more.");
      job.result = await engine.review(item, { ctx: job.ctx, profilePath: job.profilePath || undefined });
      job.state = "done";
    }
    catch (e) {
      let msg = String((e && e.message) || e);
      job.state = job.ctx.cancelled ? "cancelled" : "failed";
      job.error = job.state === "cancelled" ? "Cancelled by you." : msg;
      job.step = job.error;
    }
    job.endedAt = now();
    job.ctx = null;
    emit();
  }

  // Start the next waiting paper, if nothing runs and the queue is not paused.
  function pump() {
    if (paused || jobs.some((j) => j.state === "running")) return pending;
    let next = jobs.find((j) => j.state === "waiting");
    if (!next) return pending;
    pending = runJob(next).then(() => { pending = null; return pump(); });
    return pending;
  }

  const actions = {
    pause() { paused = true; emit(); },
    resume() { paused = false; emit(); pump(); },
    isPaused: () => paused,

    hold(id) { let j = find(id); if (j && j.state === "waiting") { j.state = "held"; j.step = "Paused by you"; emit(); } },
    release(id) { let j = find(id); if (j && j.state === "held") { j.state = "waiting"; j.step = "Waiting"; emit(); pump(); } },

    cancel(id) {
      let j = find(id);
      if (!j) return;
      if (j.state === "waiting" || j.state === "held") {
        j.state = "cancelled"; j.error = "Cancelled by you."; j.step = j.error; j.endedAt = now(); emit(); return;
      }
      if (j.state === "running" && j.ctx) {
        if (j.ctx.writing) return; // Claude finished and Zotero is saving: too late to stop safely
        j.ctx.cancelled = true;
        j.step = "Cancelling";
        if (j.ctx.kill) j.ctx.kill();
        emit();
      }
    },

    retry(id) {
      let j = find(id);
      if (!j || !FINISHED.includes(j.state) || j.state === "done") return;
      if (jobs.some((o) => o !== j && o.itemID === j.itemID && ACTIVE.includes(o.state))) return;
      Object.assign(j, { state: "waiting", step: "Waiting", pct: 0, error: null, startedAt: null, endedAt: null, log: [] });
      // move it to the end of the waiting part
      jobs.splice(jobs.indexOf(j), 1); jobs.push(j);
      emit(); pump();
    },

    // Move a waiting or held paper up or down among the papers that did not start yet.
    move(id, dir) {
      let j = find(id);
      if (!j || !["waiting", "held"].includes(j.state)) return;
      let i = jobs.indexOf(j), k = i + dir;
      while (k >= 0 && k < jobs.length && !["waiting", "held"].includes(jobs[k].state)) k += dir;
      if (k < 0 || k >= jobs.length) return;
      [jobs[i], jobs[k]] = [jobs[k], jobs[i]];
      emit();
    },

    remove(id) { let j = find(id); if (j && FINISHED.includes(j.state)) { jobs.splice(jobs.indexOf(j), 1); emit(); } },
    clearFinished() { jobs = jobs.filter((j) => !FINISHED.includes(j.state)); emit(); },
    clearWaiting() {
      for (let j of jobs) if (j.state === "waiting" || j.state === "held") { j.state = "cancelled"; j.error = "Removed from the queue."; j.step = j.error; j.endedAt = now(); }
      emit();
    },

    counts() {
      let c = { waiting: 0, held: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
      for (let j of jobs) c[j.state]++;
      return c;
    },
    get jobs() { return jobs; },
    find,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    idle() { return pending || Promise.resolve(); },
    // Called on shutdown: stop the running paper, forget the rest.
    shutdown() { for (let j of jobs) if (j.state === "running" && j.ctx && j.ctx.kill && !j.ctx.writing) j.ctx.kill(); listeners.clear(); },
  };
  return Object.assign(actions, { add });
};

if (typeof module !== "undefined") module.exports = createReviewQueue;
