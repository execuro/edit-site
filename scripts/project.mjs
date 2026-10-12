// edit-site: what kind of project this is, which files to search, and which files render a URL.
// Read-only; never writes.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const DEFAULT_EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx",
  ".html", ".htm", ".json", ".vue", ".svelte", ".astro",
];
const SKIP_DIRS = new Set(["node_modules", "out", "dist", "build", "coverage", "vendor"]);
// Config, lock and generated files never hold page copy.
const SKIP_FILE = /^(package(-lock)?\.json|npm-shrinkwrap\.json|composer\.(json|lock)|[jt]sconfig(\..+)?\.json|angular\.json|vercel\.json|netlify\.json|.*\.min\.[a-z]+|.*\.map|.*\.d\.ts)$/;
const MAX_BYTES = 1_000_000;
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte", ".astro", ".json"];

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function readJson(p, jsonc = false) {
  try {
    let s = fs.readFileSync(p, "utf8");
    if (jsonc) {
      s = s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "");
      s = s.replace(/,(\s*[}\]])/g, "$1");
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// The app's own folder: nearest package.json at or above cwd, not above the git root.
// (In a monorepo the git root is the workspace, not the app being served.)
function findRoot(cwd) {
  let git = null;
  try { git = execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  for (let d = fs.realpathSync(cwd); ; d = path.dirname(d)) {
    if (isFile(path.join(d, "package.json"))) return d;
    if (d === git || d === path.dirname(d)) break;
  }
  return git || cwd;
}

function detect(root) {
  const pkg = readJson(path.join(root, "package.json"));
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  const has = (n) => n in deps;
  const dirs = (...c) => c.filter((d) => isDir(path.join(root, d)));
  if (has("next")) return { name: "next", appDirs: dirs("app", "src/app"), pagesDirs: dirs("pages", "src/pages") };
  if (has("nuxt")) {
    const app = isDir(path.join(root, "app", "pages")) ? "app/" : ""; // Nuxt 4 moved sources into app/
    return { name: "nuxt", pagesDirs: dirs(`${app}pages`), entries: [`${app}app.vue`, `${app}layouts/default.vue`] };
  }
  if (has("@sveltejs/kit")) return { name: "sveltekit", routesDirs: dirs("src/routes") };
  if (has("@angular/core")) return { name: "angular" };
  if (has("vue")) return { name: "vue" };
  if (has("svelte")) return { name: "svelte" };
  if (has("react") || has("react-scripts") || Object.keys(deps).some((d) => d.startsWith("@remix-run/"))) return { name: "react" };
  if (has("vite")) return { name: "vite" };
  return { name: pkg ? "node" : "static" };
}

// "@/*": ["./src/*"] style aliases, longest prefix first.
function readAliases(root) {
  const out = [];
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    const co = readJson(path.join(root, f), true)?.compilerOptions || {};
    const base = path.resolve(root, co.baseUrl || ".");
    for (const [k, v] of Object.entries(co.paths || {})) {
      if (k.endsWith("/*") && Array.isArray(v) && String(v[0]).endsWith("/*")) {
        out.push([k.slice(0, -1), path.resolve(base, v[0].slice(0, -1))]);
      }
    }
  }
  const src = isDir(path.join(root, "src")) ? path.join(root, "src") : root;
  for (const [p, d] of [["@/", src], ["~/", src], ["$lib/", path.join(root, "src", "lib")]]) {
    if (!out.some(([k]) => k === p)) out.push([p, d]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

// Route-pattern segments vs URL segments. Handles [param], [...rest], [[...rest]] and [[optional]].
function matchSegs(p, u) {
  if (!p.length) return !u.length;
  const [h, ...t] = p;
  if (/^\[\[\.\.\..+\]\]$/.test(h)) return true;
  if (/^\[\.\.\..+\]$/.test(h)) return u.length > 0;
  if (/^\[\[.+\]\]$/.test(h)) return matchSegs(t, u) || (u.length > 0 && matchSegs(t, u.slice(1)));
  if (!u.length) return false;
  if (/^\[.+\]$/.test(h) || h === u[0]) return matchSegs(t, u.slice(1));
  return false;
}
const dynamicCount = (segs) => segs.filter((s) => s.startsWith("[")).length;
// (group) folders and @slot folders don't appear in the URL.
const urlSegs = (segs) => segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));

function walkAll(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

export function loadProject({ root, src, ext } = {}) {
  root = path.resolve(root || findRoot(process.cwd()));
  const fw = detect(root);
  const searchRoots = src ? String(src).split(",").map((s) => path.resolve(root, s.trim())) : [root];
  const exts = new Set(ext ? String(ext).split(",").map((e) => (e.trim().startsWith(".") ? e.trim() : "." + e.trim())) : DEFAULT_EXTS);
  const aliases = readAliases(root);

  // Files git would track (respects .gitignore); falls back to a plain walk outside git.
  function candidates(dir) {
    try {
      const out = execSync("git ls-files -z --cached --others --exclude-standard", { cwd: dir, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
      return out.toString().split("\0").filter(Boolean).map((f) => path.join(dir, f))
        .filter((f) => !path.relative(dir, f).split(path.sep).some((s) => s.startsWith(".") || SKIP_DIRS.has(s)));
    } catch {
      return walkAll(dir);
    }
  }

  function files() {
    const out = new Set();
    for (const dir of searchRoots) {
      for (const f of candidates(dir)) {
        if (!exts.has(path.extname(f)) || SKIP_FILE.test(path.basename(f))) continue;
        try { if (fs.statSync(f).size > MAX_BYTES) continue; } catch { continue; }
        out.add(f);
      }
    }
    return [...out];
  }

  function resolveImport(from, spec) {
    let base = null;
    const alias = aliases.find(([p]) => spec.startsWith(p));
    if (alias) base = path.join(alias[1], spec.slice(alias[0].length));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
    else if (spec.startsWith("/")) base = path.join(root, spec);
    if (!base) return null;
    const stripped = base.replace(/\.(m?js|jsx)$/, "");
    const tries = [base];
    for (const b of [base, stripped]) {
      for (const e of RESOLVE_EXTS) tries.push(b + e, path.join(b, "index" + e));
    }
    return tries.find(isFile) || null;
  }

  // Page files for file-based routers (Next app/, SvelteKit routes/): the most specific match wins.
  function fileRoutes(dir, pageRe, layoutRe, segs, roots) {
    const pages = walkAll(dir).filter((f) => pageRe.test(path.basename(f)));
    const hits = [];
    for (const f of pages) {
      const pattern = urlSegs(path.relative(dir, path.dirname(f)).split(path.sep).filter(Boolean));
      if (matchSegs(pattern, segs)) hits.push({ f, score: dynamicCount(pattern) });
    }
    const best = Math.min(...hits.map((h) => h.score));
    for (const { f } of hits.filter((h) => h.score === best)) {
      roots.add(f);
      for (let d = path.dirname(f); d.startsWith(dir); d = path.dirname(d)) {
        for (const l of fs.readdirSync(d)) if (layoutRe.test(l)) roots.add(path.join(d, l));
        if (d === dir) break;
      }
    }
  }

  // pages/ routers (Next Pages Router, Nuxt): about.tsx, blog/[slug].vue, docs/[...slug].tsx, index.*
  function pagesRoutes(dir, segs, roots) {
    const pages = walkAll(dir).filter((f) => /\.(tsx|ts|jsx|js|mdx|md|vue)$/.test(f) && !path.basename(f).startsWith("_"));
    const hits = [];
    for (const f of pages) {
      const rel = path.relative(dir, f).replace(/\.[^.]+$/, "").split(path.sep);
      if (rel[0] === "api") continue;
      if (rel[rel.length - 1] === "index") rel.pop();
      if (matchSegs(rel, segs)) hits.push({ f, score: dynamicCount(rel) });
    }
    const best = Math.min(...hits.map((h) => h.score));
    hits.filter((h) => h.score === best).forEach((h) => roots.add(h.f));
    for (const e of RESOLVE_EXTS) if (isFile(path.join(dir, "_app" + e))) roots.add(path.join(dir, "_app" + e));
  }

  // Every file that renders `page`: its route entry points plus everything they import.
  function routeFiles(page) {
    const segs = String(page || "/").split(/[?#]/)[0].split("/").filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
    const roots = new Set();
    for (const d of fw.appDirs || []) fileRoutes(path.join(root, d), /^page\.(tsx|ts|jsx|js|mdx|md)$/, /^(layout|template)\.(tsx|ts|jsx|js)$/, segs, roots);
    for (const d of fw.routesDirs || []) fileRoutes(path.join(root, d), /^\+page\.svelte$/, /^\+layout\.svelte$/, segs, roots);
    for (const d of fw.pagesDirs || []) pagesRoutes(path.join(root, d), segs, roots);
    for (const f of fw.entries || []) if (isFile(path.join(root, f))) roots.add(path.join(root, f));

    // Static HTML: /about/ -> about/index.html or about.html.
    const rel = segs.join("/");
    for (const b of new Set([root, ...searchRoots, path.join(root, "public")])) {
      const tries = [path.join(b, rel, "index.html")];
      if (rel) tries.push(path.join(b, rel + ".html"));
      if (/\.html?$/.test(rel)) tries.push(path.join(b, rel));
      tries.filter(isFile).forEach((f) => roots.add(f));
    }

    const seen = new Set();
    const visit = (f) => {
      if (seen.has(f) || f.includes(`${path.sep}node_modules${path.sep}`)) return;
      seen.add(f);
      let src;
      try { src = fs.readFileSync(f, "utf8"); } catch { return; }
      const specs = [
        ...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
        ...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
        ...src.matchAll(/templateUrl\s*:\s*["']([^"']+)["']/g),
        ...src.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g),
      ].map((m) => m[1]);
      for (const s of specs) {
        const r = resolveImport(f, s);
        if (r) visit(r);
      }
    };
    roots.forEach(visit);
    return seen;
  }

  function describe() {
    return {
      framework: fw.name,
      root,
      search: searchRoots.map((s) => path.relative(root, s) || "."),
      exts: [...exts],
    };
  }

  return { root, framework: fw.name, files, routeFiles, describe };
}
