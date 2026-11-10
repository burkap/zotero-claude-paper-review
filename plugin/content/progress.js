// Script of the live progress window. The plugin calls window.ClaudeLog from bootstrap code.
window.ClaudeLog = (() => {
  const $ = (id) => document.getElementById(id);
  let cancelFn = null;
  $("cancel").addEventListener("click", () => {
    if (cancelFn) { $("cancel").disabled = true; $("status").textContent = "Cancelling"; cancelFn(); }
  });
  $("close").addEventListener("click", () => window.close());
  return {
    setTitle(t) { $("title").textContent = t; document.title = "Review with Claude: " + t; },
    setStatus(text, pct) { $("status").textContent = text; if (pct !== undefined) $("bar").value = pct; },
    append(line, kind) {
      let log = $("log");
      let atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      let span = document.createElement("span");
      span.className = kind || "text";
      span.textContent = line + "\n";
      log.appendChild(span);
      if (atEnd) log.scrollTop = log.scrollHeight;
    },
    setCancel(fn) { cancelFn = fn; $("cancel").disabled = !fn; },
    finish() { cancelFn = null; $("cancel").disabled = true; },
  };
})();
