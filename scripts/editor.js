// edit-site: in-page text editor, injected into every HTML page by server.mjs.
// Toggle with the floating button or Alt+E. Click text, type, then Enter or click away to save.
// Esc reverts. Saves go to /__edit/save, which writes them into source or queues them for Claude;
// when the text has several possible homes, the bar offers them and /__edit/resolve writes the chosen one.
(() => {
  if (window.__editSite) return;
  window.__editSite = true;

  const KEY = "edit-site:on";
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "PATH", "INPUT", "TEXTAREA", "SELECT", "OPTION", "HTML", "BODY"]);
  let on = false;
  let active = null; // { el, nodes: [{node, data}], orig, origHTML }
  let hot = null;
  let saved = 0;
  let queued = 0;
  let bar, btn, info, pick;

  const css = document.createElement("style");
  css.textContent = `
    html[data-es-on] [data-es-hot] { outline: 1px dashed #3b82f6 !important; outline-offset: 2px; cursor: text !important; }
    [data-es-editing] { outline: 2px solid #3b82f6 !important; outline-offset: 2px; cursor: text !important; }
    [data-es-flash="applied"] { outline: 2px solid #16a34a !important; outline-offset: 2px; }
    [data-es-flash="queued"] { outline: 2px solid #d97706 !important; outline-offset: 2px; }
    [data-es-flash="error"] { outline: 2px solid #dc2626 !important; outline-offset: 2px; }
  `;

  const inBar = (n) => bar && (n === bar || bar.contains(n));
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());

  // The clicked element if it holds text itself; else climb up to 2 levels (icon inside a button, etc.).
  function target(n) {
    let el = n && n.nodeType === 3 ? n.parentElement : n;
    for (let i = 0; el && i < 3; i++, el = el.parentElement) {
      if (SKIP.has(el.tagName.toUpperCase()) || inBar(el)) return null;
      if (ownText(el)) return el;
    }
    return null;
  }

  function textNodes(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) out.push({ node: w.currentNode, data: w.currentNode.data });
    return out;
  }

  // The element's text with each <br> as "\n" (textContent drops them). A <br> as the very last
  // node is the placeholder browsers add after a trailing line break, not part of the text.
  function textOf(el) {
    const parts = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
      const n = w.currentNode;
      if (n.nodeType === 3) parts.push(n.data);
      else if (n.nodeName === "BR") parts.push(n);
    }
    if (typeof parts[parts.length - 1] === "object") parts.pop();
    return parts.map((p) => (typeof p === "string" ? p : "\n")).join("");
  }

  function start(el) {
    active = { el, nodes: textNodes(el), orig: textOf(el), origHTML: el.innerHTML };
    try { el.contentEditable = "plaintext-only"; } catch { el.contentEditable = "true"; }
    if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
    el.setAttribute("data-es-editing", "");
    el.addEventListener("focusout", commit, { once: true });
  }

  function stop(el) {
    el.removeAttribute("contenteditable");
    el.removeAttribute("data-es-editing");
  }

  function revert() {
    const { el, nodes, orig, origHTML } = active;
    if (nodes.every((n) => n.node.isConnected)) nodes.forEach((n) => (n.node.data = n.data));
    // Restoring the text nodes isn't enough when nodes were added (a typed line break, a split node).
    if (textOf(el) !== orig) el.innerHTML = origHTML;
  }

  async function commit() {
    if (!active) return;
    const { el, nodes, orig } = active;
    active = null;
    stop(el);
    const now = textOf(el);
    if (now === orig) return;

    // Node-level pairs are precise; only trust them if the DOM structure survived the edit.
    const intact = nodes.every((n) => n.node.isConnected) && nodes.map((n) => n.node.data).join("") === el.textContent;
    // before/after = the element's other text around this node, used to pick between duplicate matches.
    const changed = !intact ? [] : nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.node.data !== n.data)
      .map(({ n, i }) => ({
        old: n.data,
        new: n.node.data,
        before: nodes.slice(0, i).map((x) => x.data).join(""),
        after: nodes.slice(i + 1).map((x) => x.data).join(""),
      }));

    const link = el.closest("a[href]")?.getAttribute("href");
    await send(el, "/__edit/save", {
      page: location.pathname,
      lang: document.documentElement.lang,
      tag: el.tagName.toLowerCase(),
      // Where on the page and which link: tells apart the same text in header, footer and body.
      region: regionOf(el),
      href: link && link.length > 1 ? link : undefined,
      // Does this element show "\n" as a line break? If not, a break typed into a string needs a style change.
      breaks: /^(pre|pre-wrap|pre-line|break-spaces)$/.test(getComputedStyle(el).whiteSpace),
      element: { old: orig, new: now },
      nodes: changed,
    });
  }

  function regionOf(el) {
    if (el.closest("footer,[role=contentinfo]")) return "footer";
    const top = el.closest("header,nav,[role=banner],[role=navigation]");
    return top && !top.closest("main,article,section") ? "header" : "main";
  }

  async function send(el, url, body) {
    choices(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      report(el, await res.json());
    } catch (e) {
      flash(el, "error");
      say(`Save failed: ${e.message}`);
    }
  }

  function report(el, r) {
    if (r.pending != null) queued = r.pending;
    flash(el, r.status === "reverted" ? "applied" : r.followUp ? "queued" : r.status);
    if (r.status === "applied") { saved++; say(`Saved → ${r.file}:${r.line}${r.followUp ? ` · ${r.followUp}: run /edit-site apply` : ""}`); }
    else if (r.status === "reverted") say("Queued edit undone");
    else if (r.status === "queued" && r.choices?.length > 1) { say(`Found in ${r.choices.length} places. Write it to:`); choices(el, r); }
    else if (r.status === "queued") say(`Queued for Claude (${r.reason})`);
    else say(`Not saved: ${r.reason || r.status}`);
  }

  // Still ambiguous after all hints: let the user pick the file, or leave it queued for Claude.
  function choices(el, r) {
    if (!pick) return;
    pick.replaceChildren();
    pick.hidden = !r;
    if (!r) return;
    for (const c of r.choices) {
      const b = document.createElement("button");
      b.textContent = c;
      b.addEventListener("click", () => send(el, "/__edit/resolve", { id: r.id, pick: c }));
      pick.append(b);
    }
    const later = document.createElement("button");
    later.textContent = "Leave for Claude";
    later.className = "later";
    later.addEventListener("click", () => { choices(null); say(`Queued for Claude (${r.reason})`); });
    pick.append(later);
  }

  function flash(el, status) {
    el.setAttribute("data-es-flash", status);
    setTimeout(() => el.removeAttribute("data-es-flash"), 1600);
  }

  function setOn(v) {
    on = v;
    try { sessionStorage.setItem(KEY, v ? "1" : "0"); } catch {}
    document.documentElement.toggleAttribute("data-es-on", v);
    if (!v) {
      if (active) active.el.blur();
      if (hot) { hot.removeAttribute("data-es-hot"); hot = null; }
    }
    render();
  }

  // ---------- events (capture phase, so the page's own handlers never see edit-mode clicks) ----------

  window.addEventListener("mouseover", (e) => {
    if (!on || active) return;
    const el = target(e.target);
    if (el === hot) return;
    if (hot) hot.removeAttribute("data-es-hot");
    hot = el;
    if (hot) hot.setAttribute("data-es-hot", "");
  }, true);

  window.addEventListener("mousedown", (e) => {
    if (!on || inBar(e.target)) return;
    if (active && active.el.contains(e.target)) return; // moving the caret
    const el = target(e.target);
    if (!el) return;
    if (hot) { hot.removeAttribute("data-es-hot"); hot = null; }
    if (active) active.el.blur();
    start(el);
  }, true);

  window.addEventListener("click", (e) => {
    if (!on || inBar(e.target)) return;
    e.preventDefault(); // no link navigation / button actions while editing
    e.stopPropagation();
    if (!active) {
      // A click without a preceding mousedown (synthetic clicks, some assistive tech).
      const el = target(e.target);
      if (el) { start(el); el.focus(); }
    } else if (document.activeElement !== active.el) active.el.focus();
  }, true);

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyE") { e.preventDefault(); return setOn(!on); }
    if (!active) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); active.el.blur(); }
    // A visible <br> in every browser; textOf() reads it back as "\n".
    else if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertLineBreak"); }
    else if (e.key === "Escape") { e.preventDefault(); revert(); active.el.blur(); }
  }, true);

  document.addEventListener("paste", (e) => {
    if (!active || !active.el.contains(e.target)) return;
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s+/g, " "));
  }, true);

  // ---------- floating bar ----------

  function say(msg) { if (info) info.dataset.msg = msg; render(); }

  function render() {
    if (!bar) return;
    btn.textContent = on ? "✎ Editing: ON" : "✎ Edit text";
    btn.style.background = on ? "#2563eb" : "#111827";
    const counts = `${saved} saved · ${queued} queued for Claude`;
    info.textContent = info.dataset.msg ? `${counts} — ${info.dataset.msg}` : counts;
  }

  function mount() {
    document.head.appendChild(css);
    bar = document.createElement("div");
    bar.id = "edit-site-bar";
    const root = bar.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 12px/1.4 system-ui, sans-serif; }
        .box { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        button { all: unset; cursor: pointer; color: #fff; padding: 8px 12px; border-radius: 999px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
        .info { background: rgba(17,24,39,.9); color: #e5e7eb; padding: 4px 8px; border-radius: 6px; max-width: 360px; }
        .pick { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .pick[hidden] { display: none; }
        .pick button { background: #d97706; padding: 4px 10px; border-radius: 6px; font-weight: 500; box-shadow: none; }
        .pick button.later { background: #374151; }
      </style>
      <div class="box"><div class="info"></div><div class="pick" hidden></div><button class="toggle" title="Alt+E"></button></div>`;
    btn = root.querySelector("button.toggle");
    info = root.querySelector(".info");
    pick = root.querySelector(".pick");
    btn.addEventListener("click", () => setOn(!on));
    document.body.appendChild(bar);
    fetch("/__edit/status").then((r) => r.json()).then((s) => { queued = s.pending; render(); }).catch(() => {});
    let wasOn = false;
    try { wasOn = sessionStorage.getItem(KEY) === "1"; } catch {}
    setOn(wasOn);
  }

  // Mount after hydration has had a chance to finish, so React never sees our nodes.
  if (document.readyState === "complete") setTimeout(mount, 300);
  else window.addEventListener("load", () => setTimeout(mount, 300));
})();
