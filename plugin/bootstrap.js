/* global Zotero, Services, ChromeUtils, Components */
// Review with Claude: bootstrapped plugin for Zotero 7 and later (checked against 10.0.6).
var ClaudeReviewPlugin;
var chromeHandle;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  let ctx = {};
  Services.scriptloader.loadSubScript(rootURI + "lib/review-core.js", ctx);
  Services.scriptloader.loadSubScript(rootURI + "lib/claude-review.js", ctx);
  Services.scriptloader.loadSubScript(rootURI + "lib/review-queue.js", ctx);
  Services.scriptloader.loadSubScript(rootURI + "lib/queue-panel.js", ctx);
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

  // Register chrome://claude-review/content/ -> content/ (aomStartup, as in the Zotero 7 plugin docs).
  let aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "claude-review", "content/"],
  ]);

  // Live log. First try a separate window (content/progress.xhtml). If it does not become
  // ready in 4 s (it stayed blank on one test run), close it and use a panel inside the main window.
  let openLog = async () => {
    let main = Zotero.getMainWindow();
    try {
      let win = main.openDialog("chrome://claude-review/content/progress.xhtml", "claude-review-log",
        "chrome,dialog=no,resizable,centerscreen,width=760,height=520");
      for (let i = 0; i < 40; i++) {
        if (win.ClaudeLog) return win.ClaudeLog;
        await Zotero.Promise.delay(100);
      }
      Zotero.debug("claude-review: log window not ready, using the panel in the main window");
      try { win.close(); } catch (e) { /* ignore */ }
    }
    catch (e) {
      Zotero.logError(e);
    }
    return overlayLog(main);
  };

  function overlayLog(main) {
    let doc = main.document;
    const NS = "http://www.w3.org/1999/xhtml";
    let el = (tag, css, text) => {
      let e = doc.createElementNS(NS, tag);
      if (css) e.style.cssText = css;
      if (text) e.textContent = text;
      return e;
    };
    let root = el("div", "position:fixed;right:16px;bottom:16px;width:560px;height:380px;z-index:99999;" +
      "display:flex;flex-direction:column;background:Field;color:FieldText;border:1px solid GrayText;" +
      "border-radius:8px;box-shadow:0 4px 24px #0006;resize:both;overflow:hidden;font:13px sans-serif");
    let head = el("div", "padding:8px 12px;border-bottom:1px solid GrayText");
    let title = el("div", "font-weight:600", "Review with Claude");
    let status = el("div", "margin-top:2px", "Starting");
    let bar = el("progress", "width:100%;margin-top:6px");
    bar.max = 100; bar.value = 0;
    head.append(title, status, bar);
    let log = el("pre", "flex:1;overflow:auto;margin:0;padding:8px 12px;font:12px Menlo,monospace;white-space:pre-wrap;user-select:text");
    let foot = el("div", "padding:6px 12px;border-top:1px solid GrayText;text-align:right");
    let cancel = el("button", "margin-right:8px", "Cancel run");
    let close = el("button", "", "Close");
    foot.append(cancel, close);
    root.append(head, log, foot);
    doc.documentElement.appendChild(root);
    let cancelFn = null;
    cancel.disabled = true;
    cancel.addEventListener("click", () => { if (cancelFn) { cancel.disabled = true; status.textContent = "Cancelling"; cancelFn(); } });
    close.addEventListener("click", () => root.remove());
    let colors = { tool: "#0a6", file: "#07c", err: "#c22" };
    return {
      setTitle(t) { title.textContent = t; },
      setStatus(t, pct) { status.textContent = t; if (pct !== undefined) bar.value = pct; },
      append(line, kind) {
        let atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
        let span = el("span", colors[kind] ? "color:" + colors[kind] : "", line + "\n");
        log.appendChild(span);
        if (atEnd) log.scrollTop = log.scrollHeight;
      },
      setCancel(fn) { cancelFn = fn; cancel.disabled = !fn; },
      finish() { cancelFn = null; cancel.disabled = true; },
    };
  }

  let env = Components.classes["@mozilla.org/process/environment;1"]
    .getService(Components.interfaces.nsIEnvironment);
  let engine = ctx.createClaudeReview({
    Zotero,
    IOUtils,
    PathUtils,
    Subprocess,
    Core: ctx.ClaudeReviewCore,
    homeDir: Services.dirsvc.get("Home", Components.interfaces.nsIFile).path,
    platformEnv: { PATH: env.get("PATH") },
    openLog,
  });

  // Short label for the queue list: "Li 2025 — STAR: Learning Diverse ..."
  let titleOf = (item) => {
    try {
      let it = item;
      if (it.isAttachment && it.isAttachment() && it.parentItemID) it = Zotero.Items.get(it.parentItemID) || it;
      let title = it.getField("title") || "Untitled";
      let who = "", year = "";
      try { who = it.getField("firstCreator") || ""; } catch (e) { /* no creators */ }
      try { year = String(Zotero.Date.strToDate(it.getField("date")).year || ""); } catch (e) { /* no date */ }
      let head = [who, year].filter(Boolean).join(" ");
      return (head ? head + " — " : "") + title;
    }
    catch (e) { return "Item " + item.id; }
  };

  let queue = ctx.createReviewQueue({
    engine,
    getItem: (id) => Zotero.Items.getAsync(id),
    titleOf,
  });

  // A small notice when a paper finishes while the panel is hidden.
  let lastState = new Map();
  queue.subscribe(() => {
    for (let j of queue.jobs) {
      let before = lastState.get(j.id);
      if (before === "running" && j.state !== "running" && !(ClaudeReviewPlugin.panel && ClaudeReviewPlugin.panel.isShown())) {
        try {
          let pw = new Zotero.ProgressWindow({ closeOnClick: true });
          pw.changeHeadline("Review with Claude");
          let line = new pw.ItemProgress("attachment-pdf", (j.state === "done" ? "Done: " : j.state === "cancelled" ? "Cancelled: " : "Failed: ") + j.title);
          if (j.state === "done") line.setProgress(100); else line.setError();
          pw.show(); pw.startCloseTimer(6000);
        }
        catch (e) { Zotero.logError(e); }
      }
      lastState.set(j.id, j.state);
    }
  });

  let showPanel = () => {
    let win = Zotero.getMainWindow();
    if (!win) return null;
    let p = ClaudeReviewPlugin.panel;
    if (!p || p.window !== win) {
      if (p) p.destroy();
      p = ctx.createQueuePanel({
        document: win.document,
        queue,
        selectItem: (id) => { try { Zotero.getActiveZoteroPane().selectItem(id); } catch (e) { Zotero.logError(e); } },
        setTimer: (fn, ms) => win.setTimeout(fn, ms),
        clearTimer: (t) => win.clearTimeout(t),
      });
      p.window = win;
      ClaudeReviewPlugin.panel = p;
    }
    p.show();
    return p;
  };

  ClaudeReviewPlugin = { id, version, rootURI, engine, queue, panel: null, showPanel, menuID: null, manualItems: [] };

  ClaudeReviewPlugin.paneID = await Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "prefs.xhtml",
    scripts: [rootURI + "lib/review-core.js", rootURI + "lib/profile-editor.js", rootURI + "prefs-pane.js"],
  });
  let openSettings = () => {
    try { Zotero.Utilities.Internal.openPreferences(ClaudeReviewPlugin.paneID); }
    catch (e) { Zotero.logError(e); Services.prompt.alert(null, "Review with Claude", "Open Zotero > Settings > Review with Claude."); }
  };
  ClaudeReviewPlugin.openSettings = openSettings;

  // Profile list for the submenu. Zotero's menus are static, so the submenu has a fixed
  // number of profile items; each one reads this list when the menu opens.
  const SLOTS = 15;
  let profiles = [];
  let refreshProfiles = async () => {
    try { profiles = await engine.listProfiles(); } catch (e) { Zotero.logError(e); }
    return profiles;
  };
  ClaudeReviewPlugin.refreshProfiles = refreshProfiles;
  refreshProfiles();
  let model = () => ctx.ClaudeReviewCore.profileMenuModel({ profiles, defaultPath: engine.defaultProfilePath(), slots: SLOTS });

  // Right-click > Review with Claude: add every selected paper (or PDF) to the queue.
  // profilePath null = the default profile (Settings > Review with Claude).
  let run = (profilePath = null) => {
    let items = Zotero.getActiveZoteroPane().getSelectedItems()
      .filter((it) => (it.isRegularItem && it.isRegularItem()) || (it.isPDFAttachment && it.isPDFAttachment()));
    if (!items.length) {
      Services.prompt.alert(null, "Review with Claude", "Select one or more papers (or their PDFs).");
      return;
    }
    let profileName = ctx.ClaudeReviewCore.profileName(profilePath || engine.defaultProfilePath());
    let { added, skipped } = queue.add(items, { profilePath, profileName });
    let panel = showPanel();
    if (!panel) {
      let pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Review with Claude");
      new pw.ItemProgress("attachment-pdf", `Added ${added} paper(s) to the queue` + (skipped ? `, ${skipped} already in it` : ""));
      pw.show(); pw.startCloseTimer(4000);
    }
  };
  ClaudeReviewPlugin.run = run;
  ClaudeReviewPlugin.profileModel = () => ctx.ClaudeReviewCore.profileMenuModel({ profiles, defaultPath: engine.defaultProfilePath(), slots: 100 });

  if (Zotero.MenuManager && Zotero.MenuManager.registerMenu) {
    // After an upgrade without restart the old registration can still exist.
    try { Zotero.MenuManager.unregisterMenu(id + "-claude-review-item-menu"); } catch (e) { /* none */ }
    ClaudeReviewPlugin.menuID = Zotero.MenuManager.registerMenu({
      menuID: "claude-review-item-menu",
      pluginID: id,
      target: "main/library/item",
      menus: [{
        menuType: "submenu",
        // No Fluent string: the l10n file was not picked up in Zotero 10.0.6 and the label was blank.
        onShowing: (event, context) => {
          if (context.menuElem) context.menuElem.setAttribute("label", "Review with Claude");
          refreshProfiles(); // the list is read when the submenu opens, a moment later
        },
        menus: [
          {
            menuType: "menuitem",
            onShowing: (event, context) => context.menuElem && context.menuElem.setAttribute("label", model().items[0].label),
            onCommand: () => run(null),
          },
          { menuType: "separator" },
          ...Array.from({ length: SLOTS }, (_, i) => ({
            menuType: "menuitem",
            onShowing: (event, context) => {
              let it = model().items[i + 1];
              context.setVisible(!!it.visible);
              if (it.visible && context.menuElem) context.menuElem.setAttribute("label", it.label);
            },
            onCommand: () => { let it = model().items[i + 1]; if (it.path) run(it.path); },
          })),
          { menuType: "separator" },
          {
            menuType: "menuitem",
            onShowing: (event, context) => {
              let hidden = model().hidden;
              context.menuElem && context.menuElem.setAttribute("label", "Edit profiles…" + (hidden ? ` (${hidden} more not shown)` : ""));
            },
            onCommand: () => openSettings(),
          },
        ],
      }, {
        menuType: "menuitem",
        onShowing: (event, context) => context.menuElem && context.menuElem.setAttribute("label", "Show Claude review queue"),
        onCommand: () => showPanel(),
      }],
    });
  }
}

function onMainWindowLoad({ window }) {
  // Zotero 7.0 has no MenuManager: add the entry to the item context menu by hand.
  if (!(Zotero.MenuManager && Zotero.MenuManager.registerMenu)) {
    let popup = window.document.getElementById("zotero-itemmenu");
    if (!popup) return;
    let doc = window.document;
    let mi = doc.createXULElement("menu");
    mi.id = "claude-review-manual-item";
    mi.setAttribute("label", "Review with Claude");
    let sub = doc.createXULElement("menupopup");
    mi.appendChild(sub);
    let add = (label, fn) => { let m = doc.createXULElement("menuitem"); m.setAttribute("label", label); m.addEventListener("command", fn); sub.appendChild(m); };
    sub.addEventListener("popupshowing", (ev) => {
      if (ev.target !== sub) return;
      sub.replaceChildren();
      let m = ClaudeReviewPlugin.profileModel();
      add(m.items[0].label, () => ClaudeReviewPlugin.run(null));
      sub.appendChild(doc.createXULElement("menuseparator"));
      for (let it of m.items.slice(1)) if (it.visible) add(it.label, () => ClaudeReviewPlugin.run(it.path));
      sub.appendChild(doc.createXULElement("menuseparator"));
      add("Edit profiles…", () => ClaudeReviewPlugin.openSettings());
    });
    popup.addEventListener("popupshowing", (ev) => { if (ev.target === popup) ClaudeReviewPlugin.refreshProfiles(); });
    popup.appendChild(mi);
    let mq = window.document.createXULElement("menuitem");
    mq.id = "claude-review-manual-queue";
    mq.setAttribute("label", "Show Claude review queue");
    mq.addEventListener("command", () => ClaudeReviewPlugin.showPanel());
    popup.appendChild(mq);
  }
}

function onMainWindowUnload({ window }) {
  window.document.getElementById("claude-review-manual-item")?.remove();
  window.document.getElementById("claude-review-manual-queue")?.remove();
  if (ClaudeReviewPlugin && ClaudeReviewPlugin.panel && ClaudeReviewPlugin.panel.window === window) {
    ClaudeReviewPlugin.panel.destroy();
    ClaudeReviewPlugin.panel = null;
  }
}

function shutdown() {
  if (ClaudeReviewPlugin) {
    try { ClaudeReviewPlugin.queue.shutdown(); } catch (e) { /* ignore */ }
    try { ClaudeReviewPlugin.panel && ClaudeReviewPlugin.panel.destroy(); } catch (e) { /* ignore */ }
  }
  if (ClaudeReviewPlugin && ClaudeReviewPlugin.menuID && Zotero.MenuManager) {
    Zotero.MenuManager.unregisterMenu(ClaudeReviewPlugin.menuID);
  }
  if (chromeHandle) { chromeHandle.destruct(); chromeHandle = null; }
  ClaudeReviewPlugin = undefined;
}
