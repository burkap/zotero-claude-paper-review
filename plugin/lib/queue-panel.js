/* Queue panel: a box in the Zotero main window that lists the papers in the review queue,
 * shows the step of each one, and has Pause/Resume, Cancel, Retry, Up/Down buttons.
 * It is plain HTML inside the main window (a separate window stayed blank on one test run).
 * createQueuePanel({ document, queue, selectItem, setTimer, clearTimer }) -> { show, hide, toggle, isShown, destroy } */
var createQueuePanel = function ({ document: doc, queue, selectItem, setTimer, clearTimer, now = () => Date.now() }) {
  const NS = "http://www.w3.org/1999/xhtml";
  const ID = "claude-review-queue-panel";
  let root = null, selected = null, tick = null, unsub = null, dirty = false, collapsed = false;

  const ICON = { waiting: "⏳", held: "❚❚", running: "▶", done: "✔", failed: "✖", cancelled: "⊘" };
  const COLOR = { running: "#07c", done: "#0a6", failed: "#c22", cancelled: "GrayText", held: "#b80" };
  const LOGCOLOR = { tool: "#0a6", file: "#07c", err: "#c22" };

  function el(tag, css, text, attrs) {
    let e = doc.createElementNS(NS, tag);
    if (css) e.style.cssText = css;
    if (text !== undefined && text !== null) e.textContent = text;
    if (attrs) for (let k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function btn(label, title, fn, opts = {}) {
    let b = el("button", "margin:0 2px;padding:1px 7px;font:12px sans-serif;cursor:pointer", label, { title, "data-action": opts.action || title });
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    if (opts.disabled) b.disabled = true;
    return b;
  }
  function clock(ms) {
    if (ms === null || ms === undefined || ms < 0) return "–";
    let s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function elapsed(j) {
    if (!j.startedAt) return null;
    return (j.endedAt || now()) - j.startedAt;
  }

  function build() {
    root = el("div", "position:fixed;right:16px;bottom:16px;width:720px;height:460px;min-width:420px;min-height:120px;z-index:99999;" +
      "display:flex;flex-direction:column;background:Field;color:FieldText;border:1px solid GrayText;" +
      "border-radius:8px;box-shadow:0 4px 24px #0006;resize:both;overflow:hidden;font:13px sans-serif", null, { id: ID });
    doc.documentElement.appendChild(root);
    render();
  }

  function render() {
    dirty = false;
    if (!root) return;
    root.textContent = "";
    let jobs = queue.jobs, c = queue.counts(), paused = queue.isPaused();

    // header
    let head = el("div", "display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid GrayText");
    let title = el("div", "font-weight:600;flex:1", "Claude review queue");
    let sum = el("div", "font-weight:normal;color:GrayText;font-size:12px;margin-top:1px",
      `${c.running} running · ${c.waiting} waiting` + (c.held ? ` · ${c.held} paused` : "") +
      ` · ${c.done} done` + (c.failed ? ` · ${c.failed} failed` : ""));
    title.appendChild(sum);
    head.appendChild(title);
    head.appendChild(paused
      ? btn("▶ Resume queue", "Resume queue", () => queue.resume(), { action: "resume" })
      : btn("❚❚ Pause queue", "Pause queue", () => queue.pause(), { action: "pause" }));
    head.appendChild(btn("Clear finished", "Remove finished papers from the list", () => queue.clearFinished(), { action: "clear-finished", disabled: !(c.done + c.failed + c.cancelled) }));
    head.appendChild(btn("Clear waiting", "Remove all papers that did not start", () => queue.clearWaiting(), { action: "clear-waiting", disabled: !(c.waiting + c.held) }));
    head.appendChild(btn(collapsed ? "▴" : "▾", collapsed ? "Expand" : "Collapse", () => { collapsed = !collapsed; root.style.height = collapsed ? "auto" : "460px"; render(); }, { action: "collapse" }));
    head.appendChild(btn("✕", "Hide the panel (the queue continues)", () => hide(), { action: "hide" }));
    root.appendChild(head);
    if (collapsed) return;

    if (paused) {
      let running = jobs.find((j) => j.state === "running");
      root.appendChild(el("div", "padding:5px 10px;background:#fd04;border-bottom:1px solid GrayText",
        running ? `Queue paused. "${running.title}" finishes, then no new paper starts until you click Resume queue.`
          : "Queue paused. No new paper starts until you click Resume queue."));
    }

    // table
    let wrap = el("div", "flex:1 1 55%;overflow:auto;min-height:60px");
    let table = el("table", "width:100%;border-collapse:collapse;font:12.5px sans-serif");
    let hr = el("tr", "position:sticky;top:0;background:Field;text-align:left");
    for (let [h, w] of [["#", "28px"], ["Paper", ""], ["Status", "36%"], ["Time", "52px"], ["", "190px"]]) {
      hr.appendChild(el("th", `padding:4px 6px;border-bottom:1px solid GrayText;font-weight:600;${w ? "width:" + w : ""}`, h));
    }
    table.appendChild(hr);
    if (!jobs.length) {
      let tr = el("tr");
      let td = el("td", "padding:14px;color:GrayText", "The queue is empty. Select papers, right-click, and choose Review with Claude.");
      td.setAttribute("colspan", "5");
      tr.appendChild(td); table.appendChild(tr);
    }
    if (!selected || !queue.find(selected)) {
      let r = jobs.find((j) => j.state === "running");
      selected = r ? r.id : null;
    }
    jobs.forEach((j, i) => {
      let tr = el("tr", "cursor:pointer;" + (j.id === selected ? "background:Highlight;color:HighlightText" : ""), null, { "data-job": String(j.id) });
      tr.addEventListener("click", () => { selected = j.id; render(); });
      tr.appendChild(el("td", "padding:4px 6px;border-bottom:1px solid #8883", String(i + 1)));
      let pc = el("td", "padding:4px 6px;border-bottom:1px solid #8883;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", null, { title: j.title + "\nProfile: " + j.profileName });
      pc.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis", j.title));
      pc.appendChild(el("div", "font-size:11px;opacity:.7", "profile: " + j.profileName, { "data-role": "profile" }));
      tr.appendChild(pc);
      let st = el("td", "padding:4px 6px;border-bottom:1px solid #8883");
      let line = el("div", j.id === selected ? "" : `color:${COLOR[j.state] || "inherit"}`, `${ICON[j.state]} ${statusText(j)}`);
      st.appendChild(line);
      if (j.state === "running") {
        let bar = el("progress", "width:100%;height:6px");
        bar.max = 100; bar.value = j.pct || 0;
        st.appendChild(bar);
      }
      tr.appendChild(st);
      tr.appendChild(el("td", "padding:4px 6px;border-bottom:1px solid #8883;font-variant-numeric:tabular-nums", clock(elapsed(j))));
      let act = el("td", "padding:2px 4px;border-bottom:1px solid #8883;white-space:nowrap");
      for (let b of actionsFor(j)) act.appendChild(b);
      tr.appendChild(act);
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    root.appendChild(wrap);

    // log of the selected paper
    let sel = selected && queue.find(selected);
    let logHead = el("div", "padding:4px 10px;border-top:1px solid GrayText;border-bottom:1px solid #8883;font-weight:600",
      sel ? `Log: ${sel.title}` : "Log: select a paper");
    root.appendChild(logHead);
    let log = el("pre", "flex:1 1 45%;overflow:auto;margin:0;padding:6px 10px;font:11.5px Menlo,monospace;white-space:pre-wrap;user-select:text;min-height:40px", null, { "data-role": "log" });
    if (sel) {
      if (!sel.log.length) log.appendChild(el("span", "color:GrayText", sel.state === "waiting" ? "Not started yet." : sel.state === "held" ? "Paused by you. Click ▶ to put it back in the queue." : (sel.error || sel.step || "")));
      for (let l of sel.log.slice(-400)) log.appendChild(el("span", LOGCOLOR[l.kind] ? "color:" + LOGCOLOR[l.kind] : "", l.text + "\n"));
      if (sel.error && sel.log.length) log.appendChild(el("span", "color:#c22", "FAILED: " + sel.error + "\n"));
    }
    root.appendChild(log);
    log.scrollTop = log.scrollHeight;
  }

  function statusText(j) {
    switch (j.state) {
      case "waiting": return "Waiting";
      case "held": return "Paused by you";
      case "running": return j.step || "Running";
      case "done": return (j.result && j.result.annotations !== undefined) ? `Done: ${j.result.annotations} highlights and a note` : "Done";
      case "failed": return "Failed: " + String(j.error || "").slice(0, 120);
      case "cancelled": return j.error || "Cancelled";
    }
    return j.state;
  }

  function actionsFor(j) {
    let a = [];
    if (j.state === "waiting") {
      a.push(btn("↑", "Move up", () => queue.move(j.id, -1), { action: "up" }));
      a.push(btn("↓", "Move down", () => queue.move(j.id, +1), { action: "down" }));
      a.push(btn("Pause", "Pause this paper (skip it until you resume it)", () => queue.hold(j.id), { action: "hold" }));
      a.push(btn("✕", "Remove from the queue", () => queue.cancel(j.id), { action: "cancel" }));
    }
    else if (j.state === "held") {
      a.push(btn("↑", "Move up", () => queue.move(j.id, -1), { action: "up" }));
      a.push(btn("↓", "Move down", () => queue.move(j.id, +1), { action: "down" }));
      a.push(btn("Resume", "Resume this paper (put it back in the queue)", () => queue.release(j.id), { action: "release" }));
      a.push(btn("✕", "Remove from the queue", () => queue.cancel(j.id), { action: "cancel" }));
    }
    else if (j.state === "running") {
      let late = j.ctx && j.ctx.writing;
      a.push(btn("✕ Cancel", late ? "Zotero is saving the result; it cannot be stopped now" : "Stop Claude for this paper; nothing is written",
        () => queue.cancel(j.id), { action: "cancel", disabled: late || j.step === "Cancelling" }));
    }
    else if (j.state === "done") {
      if (j.result && j.result.noteID && selectItem) a.push(btn("Open note", "Show the review note", () => selectItem(j.result.noteID), { action: "open-note" }));
      a.push(btn("✕", "Remove from the list", () => queue.remove(j.id), { action: "remove" }));
    }
    else {
      a.push(btn("↻ Retry", "Put this paper back in the queue", () => queue.retry(j.id), { action: "retry" }));
      a.push(btn("✕", "Remove from the list", () => queue.remove(j.id), { action: "remove" }));
    }
    return a;
  }

  // Many updates arrive per second while Claude streams; draw at most 4 times a second.
  function schedule() {
    if (!root || dirty) return;
    dirty = true;
    setTimer(render, 250);
  }

  function show() {
    if (!root) build();
    if (!unsub) unsub = queue.subscribe(schedule);
    if (!tick) tick = setInterval_(() => { if (queue.jobs.some((j) => j.state === "running")) schedule(); }, 1000);
    root.style.display = "flex";
  }
  function hide() {
    if (root) { root.remove(); root = null; }
    if (unsub) { unsub(); unsub = null; }
    if (tick) { clearInterval_(tick); tick = null; }
  }
  // setInterval with the injected timer functions
  let intervals = new Map(), nextId = 1;
  function setInterval_(fn, ms) {
    let id = nextId++;
    let loop = () => { if (!intervals.has(id)) return; fn(); intervals.set(id, setTimer(loop, ms)); };
    intervals.set(id, setTimer(loop, ms));
    return id;
  }
  function clearInterval_(id) { let t = intervals.get(id); intervals.delete(id); if (t !== undefined && clearTimer) clearTimer(t); }

  return {
    show, hide,
    toggle() { root ? hide() : show(); },
    isShown: () => !!root,
    select(id) { selected = id; schedule(); },
    renderNow: render,
    destroy: hide,
  };
};

if (typeof module !== "undefined") module.exports = createQueuePanel;
