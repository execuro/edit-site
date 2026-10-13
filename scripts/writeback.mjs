// edit-site: find an edited piece of rendered text in the project's source and rewrite it,
// or queue it for Claude when there's no single safe place to write.
import fs from "node:fs";
import path from "node:path";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Named HTML entities worth recognising, keyed by code point.
const NAMED = {
  0x26: "amp", 0x3c: "lt", 0x3e: "gt", 0x22: "quot", 0x27: "apos",
  0x2019: "rsquo", 0x2018: "lsquo", 0x201c: "ldquo", 0x201d: "rdquo",
  0x2014: "mdash", 0x2013: "ndash", 0x2026: "hellip", 0xa9: "copy", 0xae: "reg",
  0x2122: "trade", 0xab: "laquo", 0xbb: "raquo", 0xb7: "middot", 0x2022: "bull",
  0x20ac: "euro", 0xd7: "times", 0x2192: "rarr", 0x2190: "larr",
};
// Characters the browser renders but nobody types around: word joiner, zero-width space, soft hyphen.
const INVISIBLE = new Set([0x2060, 0x200b, 0xad]);

// One rendered character -> every way it may be spelled in source (JS/JSON escapes, HTML entities).
function charPattern(c) {
  const code = c.codePointAt(0);
  const alts = [reEsc(c)];
  if (NAMED[code]) alts.push(`&${NAMED[code]};`);
  if (c === "'" || c === '"' || c === "/" || c === "`") alts.push(`\\\\${reEsc(c)}`);
  if (!/[A-Za-z0-9]/.test(c)) {
    const hex = code.toString(16);
    alts.push(`&#0*${code};`, `&#[xX]0*(?:${hex}|${hex.toUpperCase()});`);
  }
  if (code > 127) {
    const h = code.toString(16).padStart(4, "0");
    alts.push(`\\\\u(?:${h}|${h.toUpperCase()})`, `\\\\u\\{${code.toString(16)}\\}`);
  }
  return `(?:${alts.join("|")})`;
}

// Whitespace may be a newline, several spaces, {" "} in JSX, a non-breaking space in any spelling,
// or a line break: <br> in markup/JSX, an escaped \n in a string.
const WS = `(?:\\s|\\{\\s*["'] ["']\\s*\\}|&nbsp;|&#160;|\\\\u00[aA]0|<br\\b[^>]*>|\\\\n)+`;
// Word joiners may sit between any two characters in source without showing in the text we get.
const OPT_WJ = `(?:\\\\u2060|\\u2060|&#8288;)?`;

function textPattern(text) {
  let out = "";
  let inWs = false;
  for (const c of text) {
    if (/\s/.test(c)) {
      if (!inWs) out += WS;
      inWs = true;
      continue;
    }
    inWs = false;
    if (INVISIBLE.has(c.codePointAt(0))) { out += `${charPattern(c)}?`; continue; }
    out += charPattern(c) + OPT_WJ;
  }
  return out;
}

// Split old/new into shared prefix, changed middle, shared suffix.
function diff(oldS, newS) {
  let p = 0;
  while (p < oldS.length && p < newS.length && oldS[p] === newS[p]) p++;
  let s = 0;
  while (s < oldS.length - p && s < newS.length - p && oldS[oldS.length - 1 - s] === newS[newS.length - 1 - s]) s++;
  return {
    pre: oldS.slice(0, p),
    oldMid: oldS.slice(p, oldS.length - s),
    newMid: newS.slice(p, newS.length - s),
    suf: oldS.slice(oldS.length - s),
  };
}

// ---------- what surrounds a match ----------

const JS_EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
const JSX_EXT = new Set([".tsx", ".jsx"]);
const MARKUP_EXT = new Set([".html", ".htm", ".vue", ".svelte", ".astro"]);
const MD_EXT = new Set([".md", ".mdx"]);
const HTML_EXT = new Set([".html", ".htm"]);

const escaped = (src, i) => {
  let n = 0;
  while (src[i - 1 - n] === "\\") n++;
  return n % 2 === 1;
};

// Nearest unescaped quote before idx on the same line, unless a stop character comes first.
function quoteBefore(src, idx, stops) {
  const lineStart = src.lastIndexOf("\n", idx - 1) + 1;
  for (let i = idx - 1; i >= lineStart; i--) {
    const c = src[i];
    if ((c === '"' || c === "'" || c === "`") && !escaped(src, i)) return c;
    if (stops.includes(c)) return null;
  }
  return null;
}

function jsonContext(src, idx) {
  const lineStart = src.lastIndexOf("\n", idx - 1) + 1;
  let i = idx - 1;
  while (i >= lineStart && !(src[i] === '"' && !escaped(src, i))) i--;
  if (i < lineStart) return { kind: "reject", reason: "not inside a JSON string" };
  let j = idx;
  while (j < src.length && src[j] !== "\n" && !(src[j] === '"' && !escaped(src, j))) j++;
  if (src[j] !== '"') return { kind: "reject", reason: "not inside a JSON string" };
  if (/^\s*:/.test(src.slice(j + 1, j + 40))) return { kind: "reject", reason: "JSON key, not a value" };
  return { kind: "json" };
}

function markupContext(src, idx, ext) {
  const before = src.slice(0, idx);
  const lower = before.toLowerCase();
  if (lower.lastIndexOf("<script") > lower.lastIndexOf("</script")) {
    const q = quoteBefore(src, idx, "");
    return q ? { kind: "string", quote: q } : { kind: "reject", reason: "script code, not a string" };
  }
  if (lower.lastIndexOf("<style") > lower.lastIndexOf("</style")) return { kind: "reject", reason: "inside <style>" };
  if (ext === ".astro" && src.startsWith("---")) {
    const end = src.indexOf("\n---", 3);
    if (end > 0 && idx < end) {
      const q = quoteBefore(src, idx, "");
      return q ? { kind: "string", quote: q } : { kind: "reject", reason: "front matter code" };
    }
  }
  if (before.lastIndexOf("<") > before.lastIndexOf(">")) return { kind: "reject", reason: "inside a tag attribute" };
  // Inside an expression: {{ ... }} (Vue/Angular) or { ... } (Svelte/Astro). Only string literals are editable there.
  const single = ext === ".svelte" || ext === ".astro";
  const open = single ? before.lastIndexOf("{") : before.lastIndexOf("{{");
  const close = single ? before.lastIndexOf("}") : before.lastIndexOf("}}");
  if (open > close) {
    const q = quoteBefore(src, idx, "");
    return q ? { kind: "string", quote: q } : { kind: "reject", reason: "inside a template expression" };
  }
  return { kind: "markup" };
}

function contextAt(file, src, idx) {
  const ext = path.extname(file);
  if (ext === ".json") return jsonContext(src, idx);
  if (MARKUP_EXT.has(ext)) return markupContext(src, idx, ext);
  if (JSX_EXT.has(ext)) {
    const q = quoteBefore(src, idx, ">{}");
    return q ? { kind: "string", quote: q } : { kind: "jsx" };
  }
  if (JS_EXT.has(ext)) {
    // A quote found before any tag/brace is the string's own delimiter; otherwise we don't know which one.
    return { kind: "string", quote: quoteBefore(src, idx, ">{}") };
  }
  if (MD_EXT.has(ext)) return { kind: "md" };
  return { kind: "reject", reason: `unsupported file type ${ext}` };
}

const ENTITY = { "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" };

// Escape new text for where it lands. null = can't do it safely, queue for Claude instead.
// A typed line break ("\n") becomes <br> in markup and JSX, \n in strings, a hard break in Markdown.
function encodeFor(ctx, ext, text) {
  text = text.replace(/\r\n?/g, "\n");
  switch (ctx.kind) {
    case "string": {
      if (/\{\{|\}\}/.test(text)) return null; // would turn into an Angular/Vue interpolation
      const q = ctx.quote;
      let t = text.replace(/\\/g, "\\\\");
      if (q === "`") return t.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      t = t.replace(/\n/g, "\\n");
      if (q === "'" || q === '"') return t.replace(new RegExp(q, "g"), `\\${q}`);
      // Unknown delimiter: these escapes are valid in all three JS string kinds.
      return t.replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    }
    case "json":
      return JSON.stringify(text).slice(1, -1);
    case "jsx":
      // JSX text decodes HTML entities, so braces and angle brackets can be spelled as entities.
      return text.replace(/[{}<>'"]/g, (c) => ENTITY[c]).replace(/\n/g, "<br />");
    case "markup": {
      const t = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
      // Vue/Svelte/Astro decode entities after parsing expressions; Angular may not, so leave {{ to Claude there.
      if (ext === ".vue" || ext === ".svelte" || ext === ".astro") return t.replace(/[{}]/g, (c) => ENTITY[c]);
      return /\{\{|\}\}/.test(text) ? null : t;
    }
    case "md":
      return text.replace(/[\\*_[\]`{}<>]/g, "\\$&").replace(/\n/g, "\\\n");
    default:
      return null;
  }
}

// ---------- choosing between several matches ----------

// Source around a match, reduced to roughly what the browser renders.
const flat = (s) =>
  s.replace(/<[^>]*>/g, " ").replace(/\{\s*["'] ["']\s*\}/g, " ").replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// Does the rendered text around this node also surround the match in source?
function contextOk(src, start, end, ctx) {
  const b = flat(ctx.before || "").trim().slice(-24);
  const a = flat(ctx.after || "").trim().slice(0, 24);
  if (b && !flat(src.slice(Math.max(0, start - 600), start)).trimEnd().endsWith(b)) return false;
  if (a && !flat(src.slice(end, end + 600)).trimStart().startsWith(a)) return false;
  return Boolean(a || b);
}

// Does the match fill a whole string literal / text node, rather than sit inside a longer one?
function whole(src, start, end) {
  const b = src.slice(Math.max(0, start - 200), start).trimEnd().slice(-1);
  const a = src.slice(end, end + 200).trimStart()[0] || "";
  return "\"'`>}".includes(b) && b !== "" && "\"'`<{".includes(a) && a !== "";
}

// Which part of the page a match renders in, judged from its file name and enclosing tags.
const lastTag = (s, re) => Math.max(-1, ...[...s.matchAll(re)].map((m) => m.index));
function regionOf(file, src, idx) {
  const name = path.basename(file).toLowerCase();
  const before = src.slice(0, idx).toLowerCase();
  const inside = (t) => lastTag(before, new RegExp(`<${t}[\\s>]`, "g")) > lastTag(before, new RegExp(`</${t}>`, "g"));
  if (name.includes("footer") || inside("footer")) return "footer";
  if (/header|navbar|nav\.|menu/.test(name) || inside("header") || inside("nav")) return "header";
  return "main";
}

// Search anchors: the full context first, then with whole words dropped from the far ends, longest first.
// Lets text composed in code (`Step 2 of 3 — ${NAME}`) be found by the part that is literal.
function anchors(pre, mid, suf) {
  const preCuts = [0];
  for (let i = 1; i <= pre.length; i++) if (i === pre.length || (/\s/.test(pre[i - 1]) && !/\s/.test(pre[i]))) preCuts.push(i);
  const sufCuts = [suf.length];
  for (let j = suf.length - 1; j >= 0; j--) if (j === 0 || (/\s/.test(suf[j]) && !/\s/.test(suf[j - 1]))) sufCuts.push(j);
  const out = [];
  for (const i of preCuts) {
    for (const j of sufCuts) {
      if (i === 0 && j === suf.length) continue;
      const p = pre.slice(i);
      const s = suf.slice(0, j);
      if ((p + mid + s).replace(/\s+/g, " ").trim().length >= 8) out.push({ pre: p, suf: s });
    }
  }
  out.sort((x, y) => y.pre.length + y.suf.length - (x.pre.length + x.suf.length));
  return [{ pre, suf, full: true }, ...out.slice(0, 40)];
}

// en, en-US -> files under /en/, en.json, en-US.json, locales/en/common.json ...
function inLocale(file, lang) {
  if (!lang) return false;
  const want = new Set([lang.toLowerCase(), lang.toLowerCase().split("-")[0]]);
  const parts = file.toLowerCase().split(path.sep);
  const base = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  return want.has(base) || parts.slice(0, -1).some((p) => want.has(p));
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
// Why an edit wasn't written; it goes to the queue with these file:line hints.
const miss = (reason, candidates = []) => ({ status: "miss", reason, candidates });

// ---------- saving ----------

export function createSaver({ project, stateDir }) {
  const ROOT = project.root;
  const PENDING = path.join(stateDir, "pending.json");
  const APPLIED = path.join(stateDir, "applied.jsonl");
  let excluded = false;

  function readPending() {
    try { return JSON.parse(fs.readFileSync(PENDING, "utf8")); } catch { return []; }
  }

  // Keep .edit-site/ out of git without touching the project's tracked .gitignore.
  function excludeFromGit() {
    if (excluded) return;
    excluded = true;
    const info = path.join(ROOT, ".git", "info");
    if (!fs.existsSync(info)) return;
    const f = path.join(info, "exclude");
    const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    const rel = "/" + path.relative(ROOT, stateDir).split(path.sep).join("/") + "/";
    if (!cur.split("\n").includes(rel)) fs.appendFileSync(f, `${cur && !cur.endsWith("\n") ? "\n" : ""}${rel}\n`);
  }

  // One rendered text change -> a write, or a miss saying why not. `pick` ("file:line") forces one match.
  function tryApply(oldText, newText, edit, ctx, files, read, routeSet, pick) {
    if (oldText.trim() === newText.trim()) return miss("only leading/trailing whitespace changed");
    // The DOM's edge whitespace may not exist in source (JSX collapses it), so match without it.
    // Typing past it ("bar. " -> "bar. fd") keeps it as part of the new text.
    const lead = oldText.slice(0, oldText.length - oldText.trimStart().length);
    const trail = oldText.slice(oldText.trimEnd().length);
    let core = newText;
    if (lead && core.startsWith(lead)) core = core.slice(lead.length);
    if (trail && core.endsWith(trail)) core = core.slice(0, core.length - trail.length);
    const d = diff(oldText.trim(), core);
    // Short text ("FAQ") is only located as a whole string or text node, never inside a longer one.
    const short = (d.pre + d.oldMid + d.suf).replace(/\s+/g, " ").trim().length < 6;
    // No other text around this node in the page, so its source is most likely a whole string too.
    const wholeNode = !(ctx.before || "").trim() && !(ctx.after || "").trim();
    // Only whitespace changed (typically a line break typed between words): a shorter anchor could land
    // it at the edge of some string, so it must match with all its surrounding text.
    const spaceOnly = !d.oldMid.trim() && !d.newMid.trim();

    const routes = routeSet();
    const loc = (h) => `${path.relative(ROOT, h.file)}:${lineOf(h.src, h.index)}`;
    const isWhole = (h) => whole(h.src, h.index, h.end);
    // Attributes, JSON keys and style blocks can't be the rendered text. Neither can Markdown/HTML
    // documents that aren't this page (specs, snapshots, other pages that quote the same copy).
    // (HTML fragments such as Angular templates are components, not documents.)
    const isDoc = (h) => MD_EXT.has(path.extname(h.file)) || (HTML_EXT.has(path.extname(h.file)) && /<!doctype|<html[\s>]/i.test(h.src));

    let found = null;
    let first = null;
    for (const a of short || spaceOnly ? [{ pre: d.pre, suf: d.suf, full: true }] : anchors(d.pre, d.oldMid, d.suf)) {
      const re = new RegExp(`(${textPattern(a.pre)})(${textPattern(d.oldMid)})(${textPattern(a.suf)})`, "g");
      const all = [];
      for (const f of files) {
        const src = read(f);
        if (!src) continue;
        for (const m of src.matchAll(re)) {
          const midStart = m.index + m[1].length;
          all.push({ file: f, src, index: m.index, end: m.index + m[0].length, m, midStart, ctx: contextAt(f, src, midStart) });
        }
      }
      for (const h of all) {
        if (h.ctx.kind !== "reject" && isDoc(h) && !routes.has(h.file)) h.ctx = { kind: "reject", reason: "only found in a document that isn't this page" };
      }
      first ??= all;
      let hits = all.filter((h) => h.ctx.kind !== "reject");
      if (short) hits = hits.filter(isWhole);
      if (hits.length) { found = { hits, full: a.full }; break; }
    }
    if (!found) {
      const reasons = [...new Set(first.map((h) => h.ctx.reason).filter(Boolean))];
      if (short) return miss("too short to locate safely", first.map(loc));
      // The text on both sides comes from different places (`{body}{" "}<a>…`): the break belongs in the template.
      if (spaceOnly && d.newMid.includes("\n") && !first.length) return miss("line break between separately rendered texts; add it in the template (e.g. <br />)");
      return miss(reasons.join(", ") || "not found as literal text in source", first.map(loc));
    }

    let hits = found.hits;
    if (pick) {
      hits = hits.filter((h) => loc(h) === pick);
      if (hits.length !== 1) return miss(`${pick} no longer matches`);
    } else {
      // Narrow down duplicates, keeping the previous set whenever a step would rule out everything.
      const narrow = (pool, keep) => {
        if (pool.length < 2) return pool;
        const k = pool.filter(keep);
        return k.length ? k : pool;
      };
      hits = narrow(hits, (h) => routes.has(h.file));
      if (found.full && wholeNode) hits = narrow(hits, isWhole);
      hits = narrow(hits, (h) => inLocale(path.relative(ROOT, h.file), edit.lang));
      hits = narrow(hits, (h) => contextOk(h.src, h.index, h.end, ctx));
      if (edit.region) hits = narrow(hits, (h) => regionOf(h.file, h.src, h.index) === edit.region);
      if (edit.href) hits = narrow(hits, (h) => h.src.slice(Math.max(0, h.index - 300), h.end + 300).includes(edit.href));
      if (hits.length !== 1) return { ...miss(`found in ${hits.length} places`, hits.slice(0, 10).map(loc)), choices: hits.slice(0, 5).map(loc) };
    }

    const h = hits[0];
    const encoded = encodeFor(h.ctx, path.extname(h.file), d.newMid);
    if (encoded === null) return miss("new text needs manual escaping here", [loc(h)]);
    fs.writeFileSync(h.file, h.src.slice(0, h.midStart) + encoded + h.src.slice(h.midStart + h.m[2].length));
    const out = { status: "applied", file: path.relative(ROOT, h.file), line: lineOf(h.src, h.index) };
    // A \n in a string shows as a space unless the element keeps line breaks: that needs a style change.
    if (d.newMid.includes("\n") && (h.ctx.kind === "string" || h.ctx.kind === "json") && !edit.breaks) {
      out.followUp = "line break needs the element to render it";
    }
    return out;
  }

  // Try the changed text node first (most precise), then the whole element. When several nodes
  // changed in one edit, only the element as a whole describes it.
  function attempt(edit, pick) {
    const files = project.files();
    const cache = new Map();
    const read = (f) => {
      if (!cache.has(f)) { try { cache.set(f, fs.readFileSync(f, "utf8")); } catch { cache.set(f, null); } }
      return cache.get(f);
    };
    let routes = null;
    const routeSet = () => (routes ??= project.routeFiles(edit.page));
    const nodes = edit.nodes || [];
    const pairs = (nodes.length === 1 ? [nodes[0], edit.element] : [edit.element]).filter((p) => p && p.old !== p.new);
    const results = [];
    for (const p of pairs) {
      const r = tryApply(p.old, p.new, edit, p, files, read, routeSet, pick);
      if (r.status === "applied") return { outcome: r, results };
      results.push(r);
    }
    return { outcome: null, results };
  }

  function writePending(list) {
    fs.mkdirSync(stateDir, { recursive: true });
    excludeFromGit();
    if (list.length) fs.writeFileSync(PENDING, JSON.stringify(list, null, 2) + "\n");
    else fs.rmSync(PENDING, { force: true });
  }

  function logApplied(entry, outcome) {
    fs.mkdirSync(stateDir, { recursive: true });
    excludeFromGit();
    fs.appendFileSync(APPLIED, JSON.stringify({ ...entry, ...outcome }) + "\n");
  }

  // Saves run one at a time, so two quick edits never read the same file contents.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  const nextId = (pending) => Math.max(0, ...pending.map((p) => p.id)) + 1;

  // Record an applied edit. When it still needs a style change (a line break that wouldn't show),
  // that follow-up joins the queue for Claude.
  function applied(pending, entry, outcome) {
    if (outcome.followUp) {
      const { ts, page, tag, region, element } = entry;
      const reason = outcome.followUp;
      pending = [...pending, { id: nextId(pending), kind: "style", ts, page, tag, region, element, reason, candidates: [`${outcome.file}:${outcome.line}`] }];
    }
    writePending(pending);
    logApplied(entry, outcome);
    return { ...outcome, pending: pending.length };
  }

  function save(edit) {
    return serial(() => {
      let pending = readPending();
      // Editing text whose last edit is still queued: fold both into one edit from the original text.
      const prev = pending.findLast((p) => !p.kind && p.page === edit.page && p.element.new === edit.element.old);
      if (prev) {
        pending = pending.filter((p) => p !== prev);
        edit = { ...edit, element: { old: prev.element.old, new: edit.element.new }, nodes: chain(prev.nodes, edit.nodes) };
        if (edit.element.old.trim() === edit.element.new.trim()) {
          writePending(pending);
          return { status: "reverted", pending: pending.length };
        }
      }
      const { page, lang, tag, region, href, breaks, element, nodes } = edit;
      const entry = { ts: new Date().toISOString(), page, lang, tag, region, href, breaks, element, nodes };
      const { outcome, results } = attempt(edit);
      if (outcome) return applied(pending, entry, outcome);
      const reason = [...new Set(results.map((r) => r.reason))].join("; ");
      const candidates = [...new Set(results.flatMap((r) => r.candidates))];
      const choices = results.find((r) => r.choices)?.choices || [];
      const id = nextId(pending);
      pending.push({ id, ...entry, reason, candidates, choices });
      writePending(pending);
      return { status: "queued", id, reason, choices, pending: pending.length };
    });
  }

  // The user picked one of a queued edit's places in the browser: write it there.
  function resolve({ id, pick }) {
    return serial(() => {
      const pending = readPending();
      const entry = pending.find((p) => p.id === id);
      if (!entry) return { status: "error", reason: "that edit is no longer queued" };
      const { outcome, results } = attempt(entry, pick);
      if (!outcome) return { status: "queued", id, reason: results.map((r) => r.reason).join("; "), pending: pending.length };
      const { reason, candidates, choices, ...logged } = entry;
      return applied(pending.filter((p) => p !== entry), { ...logged, ts: new Date().toISOString() }, outcome);
    });
  }

  return { save, resolve, readPending };
}

// Two edits of the same single text node fold into one; anything else is described by the element.
function chain(a = [], b = []) {
  return a.length === 1 && b.length === 1 && a[0].new === b[0].old ? [{ ...a[0], new: b[0].new }] : [];
}
