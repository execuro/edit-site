#!/usr/bin/env node
// edit-site CLI: install the skill for Claude Code, or run the editing proxy on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_FILES = ["SKILL.md", "README.md", "LICENSE", "scripts"];
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "install") {
  const global = rest.includes("-g") || rest.includes("--global");
  const dest = path.join(global ? os.homedir() : process.cwd(), ".claude", "skills", "edit-site");
  if (path.resolve(dest) === PKG) {
    console.log(`[edit-site] already installed at ${dest}`);
    process.exit(0);
  }
  // Replace scripts/ wholesale so files dropped in a newer version don't linger.
  fs.rmSync(path.join(dest, "scripts"), { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of SKILL_FILES) {
    const src = path.join(PKG, f);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, f), { recursive: true });
  }
  console.log(`[edit-site] installed to ${dest}`);
  console.log("In Claude Code, run: /edit-site http://localhost:3000/");
} else if (cmd === "serve") {
  // Same flags as the skill uses: --target <origin> --root <app-folder> [--port 3001]
  process.argv.splice(2, 1);
  await import(pathToFileURL(path.join(PKG, "scripts", "server.mjs")).href);
} else {
  console.log(`Usage:
  npx @execuro/edit-site install [-g]     add the skill to this project's .claude/skills (or ~/.claude/skills with -g)
  npx @execuro/edit-site serve --target http://localhost:3000 [--root .] [--port 3001]
                                          run the editing proxy without Claude (queued edits wait in .edit-site/)`);
  process.exit(cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 1 : 0);
}
