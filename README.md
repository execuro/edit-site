# edit-site

Edit your website's text in the browser, and have Claude Code write each change straight into the source.

```
/edit-site http://localhost:3000/pricing/
```

You get `http://localhost:3001/pricing/`. Turn on **✎ Edit text**, click any text, type and press Enter. The change is written into the right source file, and your dev server hot-reloads the page.

If the text lives in several places (for example a label in both the header and the footer), the bar lists them and you click where it goes. Anything it can't place is queued: run `/edit-site apply` and Claude shows you those edits to approve.

## Install

With npm:

```sh
npx @execuro/edit-site install          # this project
npx @execuro/edit-site install -g       # all projects
```

Or with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add execuro/edit-site        # this project
npx skills add execuro/edit-site -g     # all projects
```

Or clone it into your personal Claude Code skills folder:

```sh
git clone https://github.com/execuro/edit-site ~/.claude/skills/edit-site
```

Requires Node.js 18+. There's nothing to `npm install`.

## Use

| Command | What it does |
|---|---|
| `/edit-site [url]` | Starts the dev server if needed, then the editing proxy, and gives you the link |
| `/edit-site [url] --root apps/web` | The same, for a specific app, for example in a monorepo |
| `/edit-site apply` | Reviews and applies queued edits |
| `/edit-site stop` | Stops the proxy |

Or just ask Claude to *"make the pricing page editable"*.

## Supported

Next.js (App and Pages Router, i18n JSON), Nuxt, Vue, React (Vite, CRA, Remix), Svelte/SvelteKit, Angular and static HTML.

Edits are written automatically when the text is in source: a string literal, JSX or template text, the literal part of a template string, or an i18n message. Text from a CMS or an API is queued.

## How it works

- A local proxy forwards everything to your dev server, including hot reload, and adds a small editor script to each page.
- On save, the edited text is matched against the source:
  - The search tolerates entities, escapes and line breaks.
  - It follows the page's route files and imports, then narrows by locale, the surrounding text, the page region and the link target.
  - Text built in code (`` `Step 2 — ${NAME}` ``) is found by its literal part.
- An edit is written when exactly one match is left, escaped for its context (a JS string, JSX, HTML, JSON or Markdown). If several matches are left, you pick one in the browser. Undoing a queued edit removes it from the queue.

## Safety

- It only proxies `localhost`, `127.0.0.1`, `::1`, `*.localhost` and `*.test`.
- It never guesses: an ambiguous edit is queued, and docs or snapshots that only quote the copy are never edited.
- Its state lives in `.edit-site/`, which is kept out of git automatically. Review the changes with `git diff`.

## Development

```sh
npm test                   # fixture project per supported stack; add -- --keep to inspect them
```

Every push to `master` that changes the package publishes the next patch version to npm. For a minor or major release, raise `version` in `package.json` first.

---

MIT © 2026 [Execuro](https://execuro.com)
