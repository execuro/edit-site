---
name: edit-site
description: Edit a locally running website's text directly in the browser and have every change written back into the project's source code. Starts a local proxy in front of the dev server (Next.js, Nuxt, React/Vite, Vue, Svelte/SvelteKit, Angular or plain static HTML) that makes all visible text click-to-edit; edits that can't be placed safely are queued for Claude to apply. Use this whenever the user wants to change copy, wording or typos "on the page", tweak landing-page text visually, or make a local site editable — even if they don't name the skill. Also use it to apply queued edits or stop an edit session ("/edit-site apply", "/edit-site stop").
license: MIT
compatibility: Node.js 18+. Local dev servers only.
metadata:
  author: Execuro
  homepage: https://github.com/execuro/edit-site
---

# edit-site

Serves `http://localhost:<dev-port>/page` as an editable copy at `http://localhost:3001/page`. The user clicks text, types and presses Enter. The proxy finds that text in the source and rewrites it, and the dev server hot-reloads. Nothing leaves the machine: the proxy refuses non-local targets and has no dependencies.

Script paths below are relative to this skill's base directory.

## Start: `/edit-site [url] [--root <app-folder>]`

1. **Work out the target.**
   - The URL's origin is the dev server (default `http://localhost:3000`) and its path is the page to open (default `/`). If the user gives a production URL, keep only its path, since edits must land in local source.
   - The root is the folder of the app being served, the one whose `package.json` runs the dev server. In a monorepo that's `apps/web`, not the workspace root. That folder decides what gets searched and how URLs map to files.
2. **Make sure the dev server answers** (`curl -s -o /dev/null -w '%{http_code}' <origin>/`). If it doesn't, start it in the background from the root and poll until it returns 200:
   - Use the `dev`, `start` or `serve` script from `package.json`, with the project's package manager.
   - For a plain folder of HTML files, use `python3 -m http.server <port>`.
3. **Start the proxy** in the background, unless `curl -s http://localhost:3001/__edit/health` already reports the same `root`:
   `node scripts/server.mjs --target <origin> --root <app-folder>`
   It prints one line with the URL it actually took (the port moves up if 3001 is busy), the detected framework and the root.
4. **Hand over** `http://localhost:<port><path>` with these instructions:
   - Turn on **✎ Edit text** (bottom right) or press Alt+E. Links and buttons don't navigate while it's on.
   - Click text and type. Enter or clicking away saves, and Esc reverts.
   - A **green** outline means the edit was written to source. If the text lives in several places, the bar lists them: click one to write it there.
   - **Amber** means it was queued: run `/edit-site apply` when done.

## Apply queued edits: `/edit-site apply`

The proxy writes an edit itself when it can narrow the text down to one place. It narrows by:
- the page's route files,
- whole strings,
- locale,
- the text around the edit,
- the page region (header, footer or main) and the link `href`.

What's left in the queue:
- text that isn't in source at all (CMS, API or built at runtime);
- text the user left for Claude instead of picking a place in the browser;
- new text that would need escaping that could change code (`{{` in Angular templates or in strings).

Each entry in `<root>/.edit-site/pending.json` holds:
- the element's old and new text
- the changed text node, with the text before and after it
- `page` and `lang`
- `reason`
- `candidates`: file:line hints

Steps:

1. Read the queue. If it's empty, say so.
2. Find each edit's real source. Start from `candidates`, otherwise grep for distinctive words and follow the page's route files. Then make the smallest correct change:
   - **Template literal or composed string** (`${CONST}`, a headline plus its highlighted part): edit the literal part. Change a shared constant only when that's clearly what the user meant, and keep a highlight in step with its headline.
   - **`{{ expr }}` in Vue/Nuxt/Angular, or `{expr}` in Svelte/Astro:** change the string the expression reads (component data, a computed value or an i18n message). Template syntax inside text would render literally or break the build.
   - **i18n JSON:** change only the active locale (`lang`), and mention other locales whose meaning is now stale.
   - **Duplicates:** change the copy on `page`, and ask if it's unclear which one that is.
   - **Escaping:** keep the file's existing style (`⁠`, `&apos;`, `{" "}`, `&amp;`).
3. Show a table `# | File:line | Before | After | Note` and wait for approval. These are the judgment calls the proxy declined to make, so the user should see them first.
4. Apply the approved rows and remove them from the queue (delete the file when it's empty). Then run the project's type check or linter on the touched files.

## Stop: `/edit-site stop`

Stop the background proxy. Leave the dev server running unless the user asks otherwise.

## Troubleshooting

- **`EPERM` on listen:** a sandbox is blocking local ports. Rerun outside it, or ask the user to allow local binding.
- **The page has no ✎ button:** only HTML responses get the editor. Open a page URL, not an API or asset URL, and check that the dev server itself serves that page.
- **Every edit is queued with "not found":** the text probably comes from a CMS, an API or a build step, not a source file. Or `--root` points at the wrong app.
- **The wrong copy keeps winning:** narrow the search with `--src dirA,dirB` or `--ext .tsx,.json`.

## Notes

- Only visible text is editable. Change alt, title and meta text by hand if the user asks.
- Edits go only where the text matches exactly once after narrowing by route, locale and surrounding text. Markdown and HTML documents that don't render the page (specs, snapshots) are never touched.
- `.edit-site/` is added to the project's `.git/info/exclude`, so it never appears in `git status`.
