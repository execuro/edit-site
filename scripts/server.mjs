#!/usr/bin/env node
// edit-site: a local reverse proxy in front of a dev server. It injects an inline text editor
// into every HTML page and writes saved edits back into the project's source. Node 18+, no deps.
//
//   node scripts/server.mjs [--target http://localhost:3000] [--port 3001] [--root <project>]
//                           [--src dirA,dirB] [--ext .ts,.html]

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "./project.mjs";
import { createSaver } from "./writeback.mjs";

// --flag value | --flag=value
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] ?? process.argv[++i];
}
const fail = (msg) => { console.error(`[edit-site] ${msg}`); process.exit(1); };

let TARGET;
try { TARGET = new URL(args.target || "http://localhost:3000"); } catch { fail(`invalid --target ${args.target}`); }
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
if (!LOCAL_HOSTS.has(TARGET.hostname) && !/\.(localhost|test)$/.test(TARGET.hostname)) {
  fail(`refusing non-local target ${TARGET.origin}. Point it at your local dev server.`);
}
const SECURE = TARGET.protocol === "https:";
const TARGET_PORT = Number(TARGET.port || (SECURE ? 443 : 80));
const PORT = Number(args.port || 3001);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`invalid --port ${args.port}`);
const project = loadProject({ root: args.root, src: args.src, ext: args.ext });
const STATE_DIR = path.join(project.root, ".edit-site");
const saver = createSaver({ project, stateDir: STATE_DIR });
const EDITOR_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "editor.js");

// ---------- edit endpoints ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleEdit(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__edit/editor.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    return res.end(fs.readFileSync(EDITOR_JS));
  }
  if (url.pathname === "/__edit/health") return json(res, 200, { ok: true, editSite: true, target: TARGET.origin, ...project.describe() });
  if (url.pathname === "/__edit/status") return json(res, 200, { pending: saver.readPending().length });
  const action = { "/__edit/save": saver.save, "/__edit/resolve": saver.resolve }[url.pathname];
  if (action && req.method === "POST") {
    try {
      const result = await action(JSON.parse(await readBody(req)));
      const detail = result.file ? ` ${result.file}:${result.line}` : result.reason ? ` (${result.reason})` : "";
      console.log(`[edit-site] ${result.status}${detail}`);
      return json(res, 200, result);
    } catch (e) {
      console.error("[edit-site] save failed:", e);
      return json(res, 500, { status: "error", reason: String(e.message || e) });
    }
  }
  json(res, 404, { error: "not found" });
}

// ---------- proxy ----------

function rewriteHeaders(headers, selfOrigin) {
  const h = { ...headers, host: TARGET.host };
  if (h.origin) h.origin = TARGET.origin;
  if (h.referer) h.referer = h.referer.replace(selfOrigin, TARGET.origin);
  delete h["accept-encoding"]; // ask for plain HTML so the script can be injected
  return h;
}

function decode(buf, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "gzip": case "x-gzip": return zlib.gunzipSync(buf);
    case "br": return zlib.brotliDecompressSync(buf);
    case "deflate": return zlib.inflateSync(buf);
    default: return buf;
  }
}

const TAG = '<script src="/__edit/editor.js" defer></script>';
const client = SECURE ? https : http;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/__edit/")) return void handleEdit(req, res);
  const selfOrigin = `http://${req.headers.host}`;
  const upstream = client.request(
    {
      hostname: TARGET.hostname.replace(/^\[|\]$/g, ""),
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: rewriteHeaders(req.headers, selfOrigin),
      rejectUnauthorized: false, // local dev certificates only
    },
    (up) => {
      const h = { ...up.headers };
      if (h.location) h.location = h.location.replace(TARGET.origin, selfOrigin);
      if (!String(h["content-type"] || "").includes("text/html")) {
        res.writeHead(up.statusCode, h);
        return void up.pipe(res);
      }
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        let html;
        try {
          html = decode(Buffer.concat(chunks), h["content-encoding"]).toString("utf8");
        } catch {
          res.writeHead(up.statusCode, h);
          return void res.end(Buffer.concat(chunks)); // couldn't decode: pass through untouched
        }
        // Absolute links back to the dev server should stay on the proxy.
        html = html.split(TARGET.origin).join(selfOrigin);
        const at = html.lastIndexOf("</head>");
        html = at >= 0 ? html.slice(0, at) + TAG + html.slice(at) : html + TAG;
        for (const k of ["content-length", "content-encoding", "content-security-policy", "transfer-encoding", "etag"]) delete h[k];
        h["content-length"] = Buffer.byteLength(html);
        res.writeHead(up.statusCode, h);
        res.end(html);
      });
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`edit-site: dev server not reachable at ${TARGET.origin}. Start it first.`);
  });
  req.pipe(upstream);
});

// Pass WebSocket upgrades (HMR / live reload) straight through.
server.on("upgrade", (req, socket, head) => {
  const host = TARGET.hostname.replace(/^\[|\]$/g, "");
  const onConnect = () => {
    const h = rewriteHeaders(req.headers, `http://${req.headers.host}`);
    if (req.headers["accept-encoding"]) h["accept-encoding"] = req.headers["accept-encoding"];
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const val of [].concat(v)) raw += `${k}: ${val}\r\n`;
    up.write(raw + "\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  };
  const up = SECURE
    ? tls.connect({ host, port: TARGET_PORT, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, onConnect)
    : net.connect(TARGET_PORT, host, onConnect);
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

// Use --port, or the next free port if something else already has it.
function listen(port, triesLeft) {
  server.once("error", async (e) => {
    if (e.code === "EADDRINUSE") {
      const mine = await fetch(`http://localhost:${port}/__edit/health`).then((r) => r.json()).catch(() => null);
      if (mine?.editSite && mine.root === project.root) {
        console.log(`[edit-site] already running at http://localhost:${port} for this project`);
        process.exit(0);
      }
      if (triesLeft > 0) return listen(port + 1, triesLeft - 1);
      fail(`ports ${PORT}-${port} are all busy. Pass --port.`);
    }
    if (e.code === "EPERM") fail(`not allowed to listen on ${port} (sandbox?). Run it from your own terminal or allow local binding.`);
    fail(e.message);
  });
  server.listen(port, "127.0.0.1", () => {
    const d = project.describe();
    console.log(`[edit-site] http://localhost:${port} -> ${TARGET.origin} | ${d.framework} | ${d.root} (searching ${d.search.join(", ")})`);
  });
}

listen(PORT, 20);
