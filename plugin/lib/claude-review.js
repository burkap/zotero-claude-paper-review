/* "Review with Claude": run `claude -p` on a PDF and write the result into Zotero.
 * Factory with injected globals, so Node can test it with a mocked Zotero.
 * Zotero APIs used were checked in the Zotero 10.0.6 source (see SETUP.md). */
var createClaudeReview = function ({ Zotero, IOUtils, PathUtils, Subprocess, Core, homeDir, platformEnv, openLog }) {
  const P = "extensions.claude-review.";
  const pref = (k) => Zotero.Prefs.get(P + k, true);

  function progress(headline) {
    let pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(headline);
    let line = new pw.ItemProgress("attachment-pdf", "Starting");
    pw.show();
    let finished = false; // after done/fail, late updates (from the file watcher) are ignored
    return {
      set(text, pct) { if (finished) return; line.setText(text); if (pct !== undefined) line.setProgress(pct); },
      done(text) { finished = true; line.setText(text); line.setProgress(100); pw.startCloseTimer(8000); },
      fail(text) { finished = true; line.setError(); line.setText(text); pw.startCloseTimer(30000); },
    };
  }

  async function exists(path) {
    try { return await IOUtils.exists(path); } catch (e) { return false; }
  }

  async function findClaude() {
    let p = pref("claudePath");
    if (p) {
      if (!(await exists(p))) throw new Error(`claude binary not found at: ${p} (see Settings > Review with Claude)`);
      return p;
    }
    let candidates = [
      PathUtils.join(homeDir, ".local", "bin", "claude"),
      PathUtils.join(homeDir, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
    for (let c of candidates) if (await exists(c)) return c;
    throw new Error("claude binary not found. Set its path in Settings > Review with Claude.");
  }

  async function resolveTargets(item) {
    // Returns { attachment, parent } with attachment = a PDF that is not a review attachment.
    if (item.isAttachment && item.isAttachment()) {
      if (!item.isPDFAttachment()) throw new Error("The selected attachment is not a PDF.");
      return { attachment: item, parent: item.parentItemID ? await Zotero.Items.getAsync(item.parentItemID) : item };
    }
    if (!item.isRegularItem()) throw new Error("Select a paper (or its PDF).");
    let atts = await item.getBestAttachments();
    let pdf = atts.find((a) => a.isPDFAttachment() && !a.hasTag(Core.TAG));
    if (!pdf) throw new Error("This item has no PDF attachment.");
    return { attachment: pdf, parent: item };
  }

  async function prepareWorkdir(attachment, profilePath) {
    let base = PathUtils.join(PathUtils.tempDir, "claude-review-" + Zotero.Utilities.randomString(8));
    let out = PathUtils.join(base, "out");
    await IOUtils.makeDirectory(out, { createAncestors: true });
    let pdf = PathUtils.join(base, "paper.pdf");
    let src = await attachment.getFilePathAsync();
    if (!src) throw new Error("The PDF file is missing on disk.");
    await IOUtils.copy(src, pdf);
    // Copy the whole profile folder, so `extends:` in a profile still resolves.
    let profDir = PathUtils.join(base, "profiles");
    await IOUtils.makeDirectory(profDir);
    let srcDir = PathUtils.parent(profilePath);
    for (let f of await IOUtils.getChildren(srcDir)) {
      if (Core.isProfileFile(PathUtils.filename(f))) await IOUtils.copy(f, PathUtils.join(profDir, PathUtils.filename(f)));
    }
    return { base, out, pdf, profile: PathUtils.join(profDir, PathUtils.filename(profilePath)) };
  }

  // Read a pipe to the end. Every complete line is passed to onLine as it arrives.
  async function readLines(pipe, onLine) {
    let all = "", buf = "", chunk;
    while ((chunk = await pipe.readString())) {
      all += chunk; buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) { try { onLine(line); } catch (e) { /* log only */ } }
      }
    }
    if (buf.trim()) { try { onLine(buf); } catch (e) { /* log only */ } }
    return all;
  }

  function onStreamLine(ctx, line) {
    if (!ctx.log) return;
    let obj; try { obj = JSON.parse(line); } catch (e) { return; }
    for (let { kind, text } of Core.summarizeStreamLine(obj)) ctx.log.append(text, kind);
  }

  async function readAll(pipe) {
    let out = "", chunk;
    while ((chunk = await pipe.readString())) out += chunk;
    return out;
  }

  // Steps of the skill, by the file each one writes into OUT. Shown in the progress window.
  const STEPS = [
    ["paper.txt", "Step 1/5: text extracted, Claude is applying the checks", 30],
    ["evidence.json", "Step 2/5: evidence written, locating quotes in the PDF", 50],
    ["annotations.json", "Step 3/5: quotes found, Claude is writing the review", 62],
    ["review.md", "Step 4/5: review written, building the note", 70],
    ["result.json", "Step 5/5: done, reading the result", 75],
  ];

  function startProgressWatcher(outDir, ctx, intervalMs = 2000) {
    let ui = ctx.ui, logWin = ctx.log;
    let stopped = false;
    let started = Date.now();
    let label = "Step 0/5: Claude is reading the paper", pct = 20;
    (async () => {
      while (!stopped) {
        for (let [file, text, p] of STEPS) {
          if (await exists(PathUtils.join(outDir, file))) {
            if (label !== text && pct < p) { logWin && logWin.append("✔ " + file + " written", "file"); }
            if (pct <= p) { label = text; pct = p; }
          }
        }
        let sec = Math.round((Date.now() - started) / 1000);
        let clock = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        ui.set(`${label} (${clock})`, pct);
        logWin && logWin.setStatus(`${label} (${clock})`, pct);
        await Zotero.Promise.delay(intervalMs);
      }
    })();
    return () => { stopped = true; };
  }

  // One review = one ctx: { ui, log, cancelled, kill }. Nothing is shared between two reviews.
  function checkCancel(ctx) {
    if (ctx.cancelled) throw new Error("Cancelled by you.");
  }

  async function runClaude(ctx, { claude, args, workdir, env, timeoutMs, outDir }) {
    checkCancel(ctx);
    let proc = await Subprocess.call({
      command: claude,
      arguments: args,
      workdir,
      environment: env,
      environmentAppend: true, // inherit, then apply env (null values remove variables)
      stderr: "pipe",
    });
    let stopWatch = outDir ? startProgressWatcher(outDir, ctx) : () => {};
    let stream = !!ctx.log;
    ctx.kill = () => { ctx.cancelled = true; try { proc.kill(); } catch (e) { /* gone */ } };
    if (ctx.log) ctx.log.setCancel(() => ctx.kill());
    if (ctx.cancelled) ctx.kill(); // cancel arrived while the process was starting
    let outP = stream ? readLines(proc.stdout, (l) => onStreamLine(ctx, l)) : readAll(proc.stdout);
    let errP = readAll(proc.stderr);
    let timeout = Zotero.Promise.delay(timeoutMs).then(() => "timeout");
    let done = proc.wait().then(({ exitCode }) => ({ exitCode }));
    let first;
    try {
      first = await Promise.race([done, timeout]);
    }
    catch (e) {
      stopWatch();
      try { await proc.kill(); } catch (e2) { /* already gone */ }
      throw e;
    }
    stopWatch();
    ctx.kill = null;
    checkCancel(ctx);
    if (first === "timeout") {
      await proc.kill();
      throw new Error(`Claude did not finish in ${Math.round(timeoutMs / 1000)} s. Raise the timeout in Settings.`);
    }
    return { exitCode: first.exitCode, stdout: await outP, stderr: await errP };
  }

  async function removeOld(attachment, parent) {
    await attachment.loadAllData();
    if (parent.id !== attachment.id) await parent.loadAllData();
    // Idempotence: everything this plugin made is tagged `claude-review`.
    let doomed = [];
    for (let a of attachment.getAnnotations()) if (a.hasTag(Core.TAG)) doomed.push(a);
    for (let id of parent.getNotes()) {
      let n = await Zotero.Items.getAsync(id);
      if (n.hasTag(Core.TAG)) doomed.push(n);
    }
    if (parent.isRegularItem && parent.isRegularItem()) {
      for (let id of parent.getAttachments()) {
        let a = await Zotero.Items.getAsync(id);
        if (a.id !== attachment.id && a.hasTag(Core.TAG)) doomed.push(a);
      }
    }
    return doomed;
  }

  // review(item)             -> own progress window and live log (old behaviour)
  // review(item, { ctx })     -> the queue gives ctx = { ui, log, cancelled: false }; no windows are opened
  function getSkillDir() { return pref("skillDir") || PathUtils.join(homeDir, ".claude", "skills", "paper-review"); }
  function profilesDir() { return PathUtils.join(getSkillDir(), "profiles"); }
  function defaultProfilePath() { return pref("profilePath") || PathUtils.join(profilesDir(), "default.yaml"); }
  // [{ name, path }] of the profiles in the skill folder, sorted by name.
  async function listProfiles() {
    let files = [];
    try { files = await IOUtils.getChildren(profilesDir()); } catch (e) { return []; }
    return files.filter((f) => Core.isProfileFile(PathUtils.filename(f)))
      .map((f) => ({ name: Core.profileName(f), path: f }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function review(item, opts = {}) {
    let ctx = opts.ctx;
    if (!ctx) {
      ctx = { ui: progress("Review with Claude"), log: null, cancelled: false, kill: null };
      if (pref("liveLog") !== false && openLog) {
        try { ctx.log = await openLog(); } catch (e) { Zotero.logError(e); }
      }
    }
    let ui = ctx.ui, logWin = ctx.log;
    try {
      ui.set("Looking for the PDF", 5);
      let { attachment, parent } = await resolveTargets(item);
      let claude = await findClaude();

      let skillDir = getSkillDir();
      let profilePath = opts.profilePath || defaultProfilePath();
      if (!(await exists(profilePath))) throw new Error(`Profile not found: ${profilePath}`);
      if (!(await exists(PathUtils.join(skillDir, "SKILL.md")))) {
        throw new Error(`The paper-review skill is not installed at ${skillDir}. See SETUP.md.`);
      }

      checkCancel(ctx);
      ui.set("Preparing files", 10);
      let w = await prepareWorkdir(attachment, profilePath);
      ctx.workdir = w.base;

      let pythonDir = pref("pythonDir") || PathUtils.join(homeDir, "miniconda3", "bin");
      let extra = (pref("extraPath") || "").split(":");
      let env = Core.buildEnvironment({
        inheritedPath: platformEnv.PATH,
        extraDirs: [PathUtils.parent(claude), pythonDir, ...extra],
      });
      let args = Core.buildArgs({
        prompt: Core.buildPrompt({ pdf: w.pdf, profile: w.profile, out: w.out }),
        model: pref("modelCustom") || pref("model"),
        maxTurns: pref("maxTurns"),
        stream: !!logWin,
      });

      ui.set("Claude is reading the paper (this can take several minutes)", 20);
      let run = await runClaude(ctx, { claude, args, workdir: w.base, env, timeoutMs: pref("timeoutSec") * 1000, outDir: w.out });
      let info = null;
      try { info = Core.parseClaudeJson(run.stdout); } catch (e) { /* handled below */ }
      if (run.exitCode !== 0 || !info || info.is_error) {
        let why = (info && info.result) || run.stderr || run.stdout;
        throw new Error(`Claude failed (exit ${run.exitCode}): ${String(why).slice(0, 500)}`);
      }

      ui.set("Reading the result", 70);
      let resultPath = PathUtils.join(w.out, "result.json");
      if (!(await exists(resultPath))) {
        throw new Error("Claude finished but wrote no result.json. Claude said: " + String(info.result).slice(0, 300));
      }
      let result = JSON.parse(await IOUtils.readUTF8(resultPath));
      Core.validateResult(result);
      let anns = JSON.parse(await IOUtils.readUTF8(PathUtils.join(w.out, result.annotations_file))).annotations;
      let noteHtml = await IOUtils.readUTF8(PathUtils.join(w.out, result.note_html_file));

      checkCancel(ctx); // last point where a cancel is accepted; after this the write is not stopped
      ctx.writing = true;
      ui.set("Writing annotations", 80);
      let old = await removeOld(attachment, parent);
      // Map first (this validates everything), then save. Old items go only after the new ones are saved.
      let keyed = anns.map((a) => ({ a, key: Zotero.DataObjectUtilities.generateKey() }));
      let mapped = keyed.map(({ a, key }) => Core.mapAnnotation(a, key));
      for (let json of mapped) await Zotero.Annotations.saveFromJSON(attachment, json);

      let lib = Zotero.Libraries.get(attachment.libraryID);
      let links = {};
      keyed.forEach(({ a, key }) => {
        links[a.tag] = Core.annotationUrl({
          groupID: lib.libraryType === "group" ? lib.groupID : null,
          attachmentKey: attachment.key,
          page: a.pageNumber,
          annotationKey: key,
        });
      });

      ui.set("Writing the note", 90);
      let note = new Zotero.Item("note");
      note.libraryID = attachment.libraryID;
      note.parentID = parent.id;
      note.setNote(Core.rewriteNoteLinks(noteHtml, links));
      note.addTag(Core.TAG);
      await note.saveTx();

      if (pref("attachPdf") && result.review_pdf_file) {
        let pdfPath = PathUtils.join(w.out, result.review_pdf_file);
        if (await exists(pdfPath)) {
          let att = await Zotero.Attachments.importFromFile({
            file: pdfPath,
            parentItemID: parent.id,
            title: `Claude review (${result.profile})`,
            contentType: "application/pdf",
          });
          att.addTag(Core.TAG);
          await att.saveTx();
        }
      }

      for (let d of old) await d.eraseTx();
      try { await IOUtils.remove(w.base, { recursive: true }); } catch (e) { Zotero.debug("claude-review: cleanup failed " + e); }
      logWin && (logWin.append("Done.", "file"), logWin.setStatus("Done", 100), logWin.finish());
      ui.done(`Done: ${mapped.length} highlights and a note` + (old.length ? ` (replaced ${old.length} old items)` : ""));
      return { annotations: mapped.length, links, noteID: note.id };
    }
    catch (e) {
      Zotero.logError(e);
      if (ctx.workdir) { try { await IOUtils.remove(ctx.workdir, { recursive: true }); } catch (e2) { /* ignore */ } }
      logWin && (logWin.append("FAILED: " + String(e.message || e), "err"), logWin.setStatus("Failed", undefined), logWin.finish());
      ui.fail(String(e.message || e));
      throw e;
    }
  }

  return { review, resolveTargets, findClaude, removeOld, listProfiles, defaultProfilePath, profilesDir, getSkillDir };
};

if (typeof module !== "undefined") module.exports = createClaudeReview;
