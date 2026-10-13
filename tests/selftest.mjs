#!/usr/bin/env node
// edit-site self-test: builds a tiny fixture project per stack in a temp dir, feeds edits to the
// saver exactly as the browser would, and checks what landed in the files. No server, no network.
//
//   node tests/selftest.mjs [--keep]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadProject } from "../scripts/project.mjs";
import { createSaver } from "../scripts/writeback.mjs";

const WJ = String.fromCharCode(0x2060); // word joiner as the browser renders it
const pkg = (deps, dev = {}) => JSON.stringify({ name: "fixture", dependencies: deps, devDependencies: dev }, null, 2);

const STACKS = [
  {
    name: "Next.js App Router (no src/)",
    framework: "next",
    files: {
      "package.json": pkg({ next: "16.0.0", react: "19.0.0" }),
      "tsconfig.json": '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], }, },\n}\n',
      "app/layout.tsx": 'export default function L({ children }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n',
      "app/(marketing)/about/page.tsx":
        'import { about } from "@/content/about";\nexport default function About() {\n  return (\n    <main>\n      <p>{about.intro}</p>\n      <h2>Our team builds fast</h2>\n    </main>\n  );\n}\n',
      "app/blog/[slug]/page.tsx": "export default function Post() {\n  return <h2>Our team builds fast</h2>;\n}\n",
      "content/about.ts": 'export const about = {\n  intro: "We help founders ship faster.",\n};\n',
    },
    cases: [
      { name: "content module via @/ alias", edit: { page: "/about/", element: { old: "We help founders ship faster.", new: "We help founders ship much faster." } }, expect: { file: "content/about.ts" } },
      { name: "apostrophe in a double-quoted string", edit: { page: "/about/", element: { old: "We help founders ship faster.", new: "We help founders ship what's next." } }, expect: { file: "content/about.ts", contains: ['"We help founders ship what\'s next."'] } },
      { name: "duplicate -> (group) route", edit: { page: "/about/", element: { old: "Our team builds fast", new: "Our team builds really fast" } }, expect: { file: "app/(marketing)/about/page.tsx", untouched: { "app/blog/[slug]/page.tsx": "Our team builds fast" } } },
      { name: "duplicate -> [slug] route", edit: { page: "/blog/hello-world/", element: { old: "Our team builds fast", new: "Our team ships fast" } }, expect: { file: "app/blog/[slug]/page.tsx", untouched: { "app/(marketing)/about/page.tsx": "Our team builds fast" } } },
    ],
  },
  {
    name: "Next.js Pages Router",
    framework: "next",
    files: {
      "package.json": pkg({ next: "14.0.0", react: "18.0.0" }),
      "pages/_app.tsx": "export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n",
      "pages/index.tsx": "export default function Home() {\n  return <p>Trusted by 200 product teams</p>;\n}\n",
      "pages/about.tsx": "export default function About() {\n  return <p>Trusted by 200 product teams</p>;\n}\n",
      "pages/docs/[...slug].tsx": "export default function Docs() {\n  return <p>Trusted by 200 product teams</p>;\n}\n",
    },
    cases: [
      { name: "duplicate -> pages/index", edit: { page: "/", element: { old: "Trusted by 200 product teams", new: "Trusted by 300 product teams" } }, expect: { file: "pages/index.tsx" } },
      { name: "duplicate -> pages/about", edit: { page: "/about", element: { old: "Trusted by 200 product teams", new: "Trusted by 300 product teams" } }, expect: { file: "pages/about.tsx" } },
      { name: "duplicate -> [...slug] catch-all", edit: { page: "/docs/setup/install", element: { old: "Trusted by 200 product teams", new: "Trusted by 300 product teams" } }, expect: { file: "pages/docs/[...slug].tsx" } },
    ],
  },
  {
    name: "Next.js + i18n JSON (next-intl)",
    framework: "next",
    files: {
      "package.json": pkg({ next: "16.0.0", "next-intl": "4.0.0" }),
      "app/[locale]/page.tsx": 'import { useTranslations } from "next-intl";\nexport default function Home() {\n  const t = useTranslations();\n  return <h1>{t("hero.title")}</h1>;\n}\n',
      "messages/en.json": JSON.stringify({ hero: { title: "Build better products" }, "Save changes": "Save changes" }, null, 2) + "\n",
      "messages/de.json": JSON.stringify({ hero: { title: "Bessere Produkte bauen" }, "Save changes": "Save changes" }, null, 2) + "\n",
    },
    cases: [
      { name: "message value", edit: { page: "/en", lang: "en", element: { old: "Build better products", new: "Build great products" } }, expect: { file: "messages/en.json" } },
      { name: "key equal to text is skipped; en only", edit: { page: "/en", lang: "en", element: { old: "Save changes", new: "Save all changes" } }, expect: { file: "messages/en.json", contains: ['"Save changes": "Save all changes"'], untouched: { "messages/de.json": '"Save changes": "Save changes"' } } },
      { name: "active locale picked by <html lang>", edit: { page: "/de", lang: "de", element: { old: "Save changes", new: "Änderungen speichern" } }, expect: { file: "messages/de.json", contains: ['"Save changes": "Änderungen speichern"'], untouched: { "messages/en.json": '"Save changes": "Save changes"' } } },
      { name: "line break -> \\n in JSON", edit: { page: "/en", lang: "en", element: { old: "Build better products", new: "Build better\nproducts" } }, expect: { file: "messages/en.json", contains: ['"title": "Build better\\nproducts"'] } },
      { name: "quotes escaped for JSON", edit: { page: "/en", lang: "en", element: { old: "Build better products", new: 'Build "better" products' } }, expect: { file: "messages/en.json", contains: ['"title": "Build \\"better\\" products"'] } },
    ],
  },
  {
    name: "Static HTML",
    framework: "static",
    files: {
      "index.html": '<!doctype html>\n<html lang="en">\n<body>\n  <h1>Fast &amp; friendly support</h1>\n  <img alt="Meet our friendly team" src="team.png">\n  <p>Meet our friendly team</p>\n  <footer>Made with care in Berlin</footer>\n</body>\n</html>\n',
      "about/index.html": '<!doctype html>\n<html lang="en">\n<body>\n  <p>Contact sales today</p>\n  <footer>Made with care in Berlin</footer>\n</body>\n</html>\n',
    },
    cases: [
      { name: "existing &amp; kept", edit: { page: "/", element: { old: "Fast & friendly support", new: "Fast & very friendly support" } }, expect: { file: "index.html", contains: ["Fast &amp; very friendly support"] } },
      { name: "alt attribute ignored", edit: { page: "/", element: { old: "Meet our friendly team", new: "Meet our wonderful team" } }, expect: { file: "index.html", contains: ["<p>Meet our wonderful team</p>", 'alt="Meet our friendly team"'] } },
      { name: "new & escaped", edit: { page: "/about/", element: { old: "Contact sales today", new: "Contact sales & support today" } }, expect: { file: "about/index.html", contains: ["Contact sales &amp; support today"] } },
      { name: "line break -> <br>", edit: { page: "/about/", element: { old: "Contact sales today", new: "Contact sales\ntoday" } }, expect: { file: "about/index.html", contains: ["<p>Contact sales<br>today</p>"] } },
      { name: "duplicate -> this page's file", edit: { page: "/about/", element: { old: "Made with care in Berlin", new: "Made with love in Berlin" } }, expect: { file: "about/index.html", untouched: { "index.html": "Made with care in Berlin" } } },
    ],
  },
  {
    name: "React + Vite",
    framework: "react",
    files: {
      "package.json": pkg({ react: "19.0.0", "react-dom": "19.0.0" }, { vite: "6.0.0" }),
      "index.html": '<!doctype html>\n<html lang="en">\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.tsx"></script>\n</body>\n</html>\n',
      "src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
      "src/App.tsx": 'import Hero from "./components/Hero";\nimport Pricing from "./components/Pricing";\nexport default function App() {\n  return (\n    <>\n      <Hero />\n      <Pricing />\n    </>\n  );\n}\n',
      "src/components/Hero.tsx": "export default function Hero() {\n  return (\n    <p>\n      Start free <strong>today</strong>, cancel anytime\n    </p>\n  );\n}\n",
      "src/components/Pricing.tsx": "export default function Pricing() {\n  return (\n    <p>\n      Plans for every team <strong>size</strong>, cancel anytime\n    </p>\n  );\n}\n",
    },
    cases: [
      { name: "duplicate -> surrounding text (Hero)", edit: { page: "/", element: { old: "Start free today, cancel anytime", new: "Start free today, cancel whenever" }, nodes: [{ old: ", cancel anytime", new: ", cancel whenever", before: "Start free today", after: "" }] }, expect: { file: "src/components/Hero.tsx", contains: ["</strong>, cancel whenever"], untouched: { "src/components/Pricing.tsx": ", cancel anytime" } } },
      { name: "client-side route -> surrounding text", edit: { page: "/pricing", element: { old: "Plans for every team size, cancel anytime", new: "Plans for every team size, cancel whenever" }, nodes: [{ old: ", cancel anytime", new: ", cancel whenever", before: "Plans for every team size", after: "" }] }, expect: { file: "src/components/Pricing.tsx", contains: ["</strong>, cancel whenever"], untouched: { "src/components/Hero.tsx": ", cancel anytime" } } },
      { name: "apostrophe in JSX text", edit: { page: "/", element: { old: "Start free today, cancel anytime", new: "Start it's free today, cancel anytime" }, nodes: [{ old: "Start free ", new: "Start it's free ", before: "", after: "today, cancel anytime" }] }, expect: { file: "src/components/Hero.tsx", contains: ["Start it&apos;s free <strong>"] } },
    ],
  },
  {
    name: "Vue",
    framework: "vue",
    files: {
      "package.json": pkg({ vue: "3.5.0" }, { vite: "6.0.0" }),
      "src/components/Hero.vue": "<template>\n  <section>\n    <h1>Ship your product faster</h1>\n    <p>{{ tagline }}</p>\n    <button :title=\"'Ship your product faster'\">Go</button>\n  </section>\n</template>\n\n<script setup>\nconst tagline = 'Loved by over 2,000 teams'\n</script>\n",
    },
    cases: [
      { name: "template text (attribute ignored)", edit: { page: "/", element: { old: "Ship your product faster", new: "Ship your product much faster" } }, expect: { file: "src/components/Hero.vue", contains: ["<h1>Ship your product much faster</h1>", ":title=\"'Ship your product faster'\""] } },
      { name: "<script> string", edit: { page: "/", element: { old: "Loved by over 2,000 teams", new: "Loved by over 2,000 teams worldwide" } }, expect: { file: "src/components/Hero.vue", contains: ["'Loved by over 2,000 teams worldwide'"] } },
      { name: "<script> string with apostrophe", edit: { page: "/", element: { old: "Loved by over 2,000 teams", new: "Loved by over 2,000 teams, it's true" } }, expect: { file: "src/components/Hero.vue", contains: ["'Loved by over 2,000 teams, it\\'s true'"] } },
      { name: "{{ }} in new text -> entities", edit: { page: "/", element: { old: "Ship your product faster", new: "Ship {{ speed }}" } }, expect: { file: "src/components/Hero.vue", contains: ["<h1>Ship &#123;&#123; speed &#125;&#125;</h1>"] } },
    ],
  },
  {
    name: "SvelteKit",
    framework: "sveltekit",
    files: {
      "package.json": pkg({}, { "@sveltejs/kit": "2.0.0", svelte: "5.0.0" }),
      "src/routes/+page.svelte": '<script>\n  import Footer from "$lib/Footer.svelte";\n  let name = "world";\n</script>\n\n<h1>Welcome to the dashboard</h1>\n<p>Hello {name}, good to see you</p>\n<Footer />\n',
      "src/routes/settings/+page.svelte": "<h1>Welcome to the dashboard</h1>\n",
      "src/lib/Footer.svelte": "<footer>Built with care by the team</footer>\n",
    },
    cases: [
      { name: "duplicate -> /settings route", edit: { page: "/settings", element: { old: "Welcome to the dashboard", new: "Welcome to your settings" } }, expect: { file: "src/routes/settings/+page.svelte" } },
      { name: "duplicate -> / route", edit: { page: "/", element: { old: "Welcome to the dashboard", new: "Welcome back to the dashboard" } }, expect: { file: "src/routes/+page.svelte" } },
      { name: "$lib component", edit: { page: "/", element: { old: "Built with care by the team", new: "Built with love by the team" } }, expect: { file: "src/lib/Footer.svelte" } },
      { name: "text next to {expression}", edit: { page: "/", element: { old: "Hello world, good to see you", new: "Hello world, great to see you" }, nodes: [{ old: ", good to see you", new: ", great to see you", before: "Hello world", after: "" }] }, expect: { file: "src/routes/+page.svelte", contains: ["Hello {name}, great to see you"] } },
      { name: "{ in new text -> entities", edit: { page: "/settings", element: { old: "Welcome to the dashboard", new: "Welcome {user}" } }, expect: { file: "src/routes/settings/+page.svelte", contains: ["Welcome &#123;user&#125;"] } },
    ],
  },
  {
    name: "Angular",
    framework: "angular",
    files: {
      "package.json": pkg({ "@angular/core": "19.0.0" }),
      "src/app/hero/hero.component.html": "<section>\n  <h1>Plan your next trip</h1>\n  <p>{{ subtitle }}</p>\n</section>\n",
      "src/app/hero/hero.component.ts": "import { Component } from '@angular/core';\n@Component({ selector: 'app-hero', templateUrl: './hero.component.html' })\nexport class HeroComponent {\n  subtitle = 'Flights, hotels and more';\n}\n",
      "src/app/badge.component.ts": "import { Component } from '@angular/core';\n@Component({\n  selector: 'app-badge',\n  template: '<span class=\"badge\">Free for small teams</span>',\n})\nexport class BadgeComponent {}\n",
    },
    cases: [
      { name: "component .html template", edit: { page: "/", element: { old: "Plan your next trip", new: "Plan your next big trip" } }, expect: { file: "src/app/hero/hero.component.html" } },
      { name: "inline template string", edit: { page: "/", element: { old: "Free for small teams", new: "Free for small teams, it's true" } }, expect: { file: "src/app/badge.component.ts", contains: ["Free for small teams, it\\'s true</span>'"] } },
      { name: "component property string", edit: { page: "/", element: { old: "Flights, hotels and more", new: "Flights, hotels and much more" } }, expect: { file: "src/app/hero/hero.component.ts" } },
      { name: "{{ }} in new text -> queued", edit: { page: "/", element: { old: "Plan your next trip", new: "Plan {{ trip }}" } }, expect: { status: "queued" } },
    ],
  },
  {
    name: "Nuxt",
    framework: "nuxt",
    files: {
      "package.json": pkg({ nuxt: "4.0.0", vue: "3.5.0" }),
      "app/app.vue": "<template>\n  <NuxtLayout><NuxtPage /></NuxtLayout>\n</template>\n",
      "app/layouts/default.vue": "<template>\n  <div>\n    <slot />\n    <footer>Questions? Write to the team</footer>\n  </div>\n</template>\n",
      "app/pages/index.vue": "<template>\n  <h1>Find your next favourite book</h1>\n</template>\n",
      "app/pages/books/[id].vue": "<template>\n  <h1>Find your next favourite book</h1>\n</template>\n",
      "app/components/Promo.vue": "<template>\n  <p>Questions? Write to the team</p>\n</template>\n",
    },
    cases: [
      { name: "duplicate -> pages/index.vue", edit: { page: "/", element: { old: "Find your next favourite book", new: "Find your next great book" } }, expect: { file: "app/pages/index.vue", untouched: { "app/pages/books/[id].vue": "favourite book" } } },
      { name: "duplicate -> pages/books/[id].vue", edit: { page: "/books/42", element: { old: "Find your next favourite book", new: "Find a similar book" } }, expect: { file: "app/pages/books/[id].vue", untouched: { "app/pages/index.vue": "favourite book" } } },
      { name: "layout text preferred over unused component", edit: { page: "/", element: { old: "Questions? Write to the team", new: "Questions? Email the team" } }, expect: { file: "app/layouts/default.vue", untouched: { "app/components/Promo.vue": "Write to the team" } } },
    ],
  },
  {
    name: "Monorepo app folder",
    framework: "next",
    app: "apps/web", // expected root, found without --root from cwd below, inside a git workspace
    cwd: "apps/web/app",
    git: true,
    files: {
      "package.json": JSON.stringify({ name: "workspace", private: true, workspaces: ["apps/*"] }, null, 2),
      "apps/web/package.json": pkg({ next: "16.0.0" }),
      "apps/web/app/page.tsx": "export default function Home() {\n  return <h1>Welcome to the web app</h1>;\n}\n",
      "apps/docs/package.json": pkg({ next: "16.0.0" }),
      "apps/docs/app/page.tsx": "export default function Home() {\n  return <h1>Welcome to the web app</h1>;\n}\n",
    },
    cases: [
      { name: "root = app folder, sibling app untouched", edit: { page: "/", element: { old: "Welcome to the web app", new: "Welcome to our web app" } }, expect: { file: "app/page.tsx", untouched: { "apps/docs/app/page.tsx": "Welcome to the web app" } } },
    ],
  },
  {
    name: "Header, footer, links, picker",
    framework: "next",
    files: {
      "package.json": pkg({ next: "16.0.0" }),
      "app/layout.tsx":
        'import { SiteHeader } from "../components/SiteHeader";\nimport { SiteFooter } from "../components/SiteFooter";\nexport default function RootLayout({ children }) {\n  return <html lang="en"><body><SiteHeader />{children}<SiteFooter /></body></html>;\n}\n',
      "components/SiteHeader.tsx":
        'const NAV = [\n  { label: "Free Trial", ariaLabel: "Free Trial: Start in minutes", href: "/trial/" },\n  { label: "FAQ", href: "/faq/" },\n];\nexport function SiteHeader() {\n  return <header>{NAV.map((n) => <a key={n.href} href={n.href} aria-label={n.ariaLabel}>{n.label}</a>)}</header>;\n}\n',
      "components/SiteFooter.tsx":
        'import Link from "next/link";\nexport function SiteFooter() {\n  return (\n    <footer>\n      <Link href="/trial/">\n        Free Trial\n      </Link>\n    </footer>\n  );\n}\n',
      "components/PlanLink.tsx": 'export function PlanLink() {\n  return <a href="/pricing/">See all plans</a>;\n}\n',
      "content/home.ts": 'export const intro = {\n  stepOne: "Step 1 is the Free Trial",\n};\n',
      "app/page.tsx":
        'import { intro } from "../content/home";\nimport { PlanLink } from "../components/PlanLink";\nexport default function Home() {\n  return (\n    <main>\n      <p>{intro.stepOne}</p>\n      <p>FAQ and support live on the help page</p>\n      <p>Use plain text in templates</p>\n      <a href="/plans/">See all plans</a>\n      <PlanLink />\n    </main>\n  );\n}\n',
      "app/docs/page.mdx": "# Docs\n\nWrite your notes here.\n",
    },
    cases: [
      { name: "clicked in footer -> footer", edit: { page: "/", region: "footer", href: "/trial/", element: { old: "Free Trial", new: "Try It Free" } }, expect: { file: "components/SiteFooter.tsx", untouched: { "components/SiteHeader.tsx": 'label: "Free Trial"' } } },
      { name: "clicked in header -> whole label, not aria", edit: { page: "/", region: "header", href: "/trial/", element: { old: "Free Trial", new: "Free Trials" } }, expect: { file: "components/SiteHeader.tsx", contains: ['label: "Free Trials"', 'ariaLabel: "Free Trial: Start'], untouched: { "content/home.ts": "the Free Trial\"", "components/SiteFooter.tsx": "Free Trial\n" } } },
      { name: "short whole label", edit: { page: "/", region: "header", element: { old: "FAQ", new: "Help" } }, expect: { file: "components/SiteHeader.tsx", contains: ['label: "Help"'], untouched: { "app/page.tsx": "FAQ and support" } } },
      { name: "same link text -> href decides", edit: { page: "/", region: "main", href: "/pricing/", element: { old: "See all plans", new: "See every plan" } }, expect: { file: "components/PlanLink.tsx", untouched: { "app/page.tsx": '<a href="/plans/">See all plans</a>' } } },
      { name: "{ } in JSX -> entities", edit: { page: "/", element: { old: "Use plain text in templates", new: "Use {braces} in templates" } }, expect: { file: "app/page.tsx", contains: ["Use &#123;braces&#125; in templates"] } },
      { name: "Markdown characters escaped", edit: { page: "/docs/", element: { old: "Write your notes here.", new: "Write *your* notes here." } }, expect: { file: "app/docs/page.mdx", contains: ["Write \\*your\\* notes here."] } },
      { name: "ambiguous -> picked in the browser", steps: [{ edit: { page: "/", element: { old: "Free Trial", new: "Try It Free" } }, expect: { status: "queued", choices: 2 } }, { pick: "components/SiteFooter.tsx:6" }], expect: { file: "components/SiteFooter.tsx", contains: ["Try It Free"], pending: 0 } },
      { name: "queued, then undone", steps: [{ edit: { page: "/", element: { old: "Free Trial", new: "Free Trial 1" } }, expect: { status: "queued" } }, { edit: { page: "/", element: { old: "Free Trial 1", new: "Free Trial" } } }], expect: { status: "reverted", pending: 0 } },
      { name: "queued, then edited again", steps: [{ edit: { page: "/", element: { old: "Free Trial", new: "Free Trial 1" } }, expect: { status: "queued" } }, { edit: { page: "/", element: { old: "Free Trial 1", new: "Free Trial 2" } } }], expect: { status: "queued", pending: 1 } },
    ],
  },
  {
    name: "Line breaks",
    framework: "next",
    files: {
      "package.json": pkg({ next: "16.0.0" }),
      "content/pricing.ts": 'export const pricing = {\n  frame: "Fixed price per project. No hourly billing.",\n  terms: "Cancel any time. Refunds within 30 days.",\n  body: "Plans for every team size.",\n  label: "Compare all plans",\n};\n',
      "app/page.tsx":
        'import { pricing } from "../content/pricing";\nexport default function Home() {\n  return (\n    <main>\n      <h1>Complex<br/>E-Commerce</h1>\n      <p>Fast setup and friendly support</p>\n      <p className="whitespace-pre-line">{pricing.terms}</p>\n      <p>{pricing.frame}</p>\n      <p>{pricing.body}{" "}<a href="/compare/">{pricing.label} &rarr;</a></p>\n    </main>\n  );\n}\n',
      "app/docs/page.mdx": "# Docs\n\nRead the guide first.\n",
    },
    cases: [
      { name: "typed in JSX text -> <br />", edit: { page: "/", element: { old: "Fast setup and friendly support", new: "Fast setup\nand friendly support" } }, expect: { file: "app/page.tsx", contains: ["<p>Fast setup<br />and friendly support</p>"] } },
      { name: "typed in a string -> \\n + style follow-up", edit: { page: "/", element: { old: "Fixed price per project. No hourly billing.", new: "Fixed price per project.\nNo hourly billing." } }, expect: { file: "content/pricing.ts", contains: ['"Fixed price per project.\\nNo hourly billing."'], followUp: true, pending: 1 } },
      { name: "string in a pre-line element -> no follow-up", edit: { page: "/", breaks: true, element: { old: "Cancel any time. Refunds within 30 days.", new: "Cancel any time.\nRefunds within 30 days." } }, expect: { file: "content/pricing.ts", contains: ['"Cancel any time.\\nRefunds within 30 days."'], followUp: false, pending: 0 } },
      { name: "text around a <br/> still matches", edit: { page: "/", element: { old: "Complex\nE-Commerce", new: "Complex\nCommerce" } }, expect: { file: "app/page.tsx", contains: ["<h1>Complex<br/>Commerce</h1>"] } },
      { name: "line break removed -> <br/> gone", edit: { page: "/", element: { old: "Complex\nE-Commerce", new: "Complex E-Commerce" } }, expect: { file: "app/page.tsx", contains: ["<h1>Complex E-Commerce</h1>"] } },
      { name: "break between two rendered texts -> queued", edit: { page: "/", element: { old: "Plans for every team size. Compare all plans →", new: "Plans for every team size. \nCompare all plans →" } }, expect: { status: "queued", reason: "template", untouched: { "content/pricing.ts": 'body: "Plans for every team size.",' } } },
      { name: "typed in Markdown -> hard break", edit: { page: "/docs/", element: { old: "Read the guide first.", new: "Read the guide\nfirst." } }, expect: { file: "app/docs/page.mdx", contains: ["Read the guide\\\nfirst."] } },
    ],
  },
  {
    name: "Next.js (src/, escapes, composed copy)",
    framework: "next",
    files: {
      "package.json": pkg({ next: "16.0.0" }),
      "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n',
      "src/content/shared.ts": 'export const PRODUCT = "Acme Cloud";\n',
      "src/content/home.ts":
        'import { PRODUCT } from "@/content/shared";\nexport const hero = {\n  badge: `Step 2 of 3 — ${PRODUCT}`,\n  headline: "Every developer ships the feature — not just your seniors.",\n  headlineHighlight: "developer",\n  sub: "Set up in 1\\u2060–\\u20603 days, on a plan you already have.",\n  note: "Pick a plan that fits your team. ",\n};\n',
      "src/app/home/page.tsx":
        'import { hero } from "@/content/home";\nexport const metadata = {\n  description: "Expand into new cities in Spain, Italy and Greece with a local team",\n};\nexport default function Page() {\n  return (\n    <main>\n      <h1>\n        Expand Into{" "}\n        <span>New Cities</span> in Spain, Italy and Greece\n      </h1>\n      <p>Expand into new cities in Spain, Italy and Greece with ease</p>\n      <p>No commitment - We&apos;ll reply within a business day</p>\n    </main>\n  );\n}\n',
      "src/app/other/page.tsx": 'export default function Other() {\n  return (\n    <h1>\n      Launch Your Online Store with a{" "}\n      <span>Product Team</span>\n    </h1>\n  );\n}\n',
      "src/app/pricing/page.tsx": "export default function Pricing() {\n  return <p>Our legacy pricing still applies</p>;\n}\n",
      "src/pages/legacy.tsx": "export default function Legacy() {\n  return <p>Our legacy pricing still applies</p>;\n}\n",
      "specs/notes.md": "# Notes\n\nMarker reads: Step 2 of 3 — Acme Cloud\n",
      "snapshot/home.html": "<!doctype html>\n<html><body><p>Step 2 of 3 — Acme Cloud</p></body></html>\n",
    },
    cases: [
      { name: "\\u2060 escapes kept", edit: { page: "/home/", element: { old: `Set up in 1${WJ}–${WJ}3 days, on a plan you already have.`, new: `Set up in 1${WJ}–${WJ}3 days, on the plan you already have.` } }, expect: { file: "src/content/home.ts", contains: ["1\\u2060–\\u20603 days, on the plan you already have."] } },
      { name: "split highlight (one text node)", edit: { page: "/home/", element: { old: "Every developer ships the feature — not just your seniors.", new: "Every developer ships the feature — not only your seniors." }, nodes: [{ old: " ships the feature — not just your seniors.", new: " ships the feature — not only your seniors.", before: "Every developer", after: "" }] }, expect: { file: "src/content/home.ts", contains: ['"Every developer ships the feature — not only your seniors."'] } },
      { name: "two text nodes changed -> whole element", edit: { page: "/home/", element: { old: "Every developer ships the feature — not just your seniors.", new: "Each developer ships the feature — not only your seniors." }, nodes: [{ old: "Every ", new: "Each ", before: "", after: "developer ships the feature — not just your seniors." }, { old: " ships the feature — not just your seniors.", new: " ships the feature — not only your seniors.", before: "Every developer", after: "" }] }, expect: { file: "src/content/home.ts", contains: ['"Each developer ships the feature — not only your seniors."'] } },
      { name: "template literal: literal part", edit: { page: "/home/", element: { old: "Step 2 of 3 — Acme Cloud", new: "Step 3 of 3 — Acme Cloud" } }, expect: { file: "src/content/home.ts", contains: ["`Step 3 of 3 — ${PRODUCT}`"] } },
      { name: "template literal: the constant it reads", edit: { page: "/home/", element: { old: "Step 2 of 3 — Acme Cloud", new: "Step 2 of 3 — Acme Platform" } }, expect: { file: "src/content/shared.ts", contains: ['"Acme Platform"'], untouched: { "src/content/home.ts": "`Step 2 of 3 — ${PRODUCT}`" } } },
      { name: "&apos; in JSX", edit: { page: "/home/", element: { old: "No commitment - We'll reply within a business day", new: "No commitment - we'll reply within one business day" } }, expect: { file: "src/app/home/page.tsx", contains: ["we&apos;ll reply within one business day"] } },
      { name: '{" "} spacer + apostrophe', edit: { page: "/other/", element: { old: "Launch Your Online Store with a Product Team", new: "Launch Your Company's Store with a Product Team" }, nodes: [{ old: "Launch Your Online Store with a", new: "Launch Your Company's Store with a", before: "", after: "Product Team" }] }, expect: { file: "src/app/other/page.tsx", contains: ['Launch Your Company&apos;s Store with a{" "}'] } },
      { name: "3 copies on one page -> surrounding text", edit: { page: "/home/", element: { old: "Expand Into New Cities in Spain, Italy and Greece", new: "Expand Into New Cities in Spain, Italy and Portugal" }, nodes: [{ old: " in Spain, Italy and Greece", new: " in Spain, Italy and Portugal", before: "Expand Into New Cities", after: "" }] }, expect: { file: "src/app/home/page.tsx", contains: ["</span> in Spain, Italy and Portugal", "new cities in Spain, Italy and Greece with ease", "new cities in Spain, Italy and Greece with a local"] } },
      { name: "app/ and pages/ side by side -> pages", edit: { page: "/legacy", element: { old: "Our legacy pricing still applies", new: "Our old pricing still applies" } }, expect: { file: "src/pages/legacy.tsx", untouched: { "src/app/pricing/page.tsx": "legacy pricing" } } },
      { name: "app/ and pages/ side by side -> app", edit: { page: "/pricing/", element: { old: "Our legacy pricing still applies", new: "Our current pricing applies" } }, expect: { file: "src/app/pricing/page.tsx", untouched: { "src/pages/legacy.tsx": "legacy pricing" } } },
      { name: "typing past a trailing space in source", edit: { page: "/home/", element: { old: "Pick a plan that fits your team. ", new: "Pick a plan that fits your team. Change it later." } }, expect: { file: "src/content/home.ts", contains: ['"Pick a plan that fits your team. Change it later. "'] } },
      { name: "trailing space only in the DOM", edit: { page: "/pricing/", element: { old: "Our legacy pricing still applies ", new: "Our legacy pricing still applies today" } }, expect: { file: "src/app/pricing/page.tsx", contains: ["<p>Our legacy pricing still applies today</p>"] } },
      { name: "edge whitespace only -> queued", edit: { page: "/home/", element: { old: "Pick a plan that fits your team. ", new: "Pick a plan that fits your team.  " } }, expect: { status: "queued" } },
      { name: "very short text -> queued", edit: { page: "/home/", element: { old: "Open", new: "Opened" } }, expect: { status: "queued" } },
      { name: "doc quoting the copy is never edited", edit: { page: "/home/", element: { old: "Step 2 of 3 — Acme Cloud", new: "Step 2 of 3 — Acme Platform" } }, expect: { file: "src/content/shared.ts", contains: ['"Acme Platform"'], untouched: { "specs/notes.md": "Marker reads: Step 2 of 3 — Acme Cloud" } } },
      { name: "snapshot page quoting the copy is never edited", edit: { page: "/home/", element: { old: "Step 2 of 3 — Acme Cloud", new: "Step 2 of 3 — Acme Platform" } }, expect: { file: "src/content/shared.ts", contains: ['"Acme Platform"'], untouched: { "snapshot/home.html": "<p>Step 2 of 3 — Acme Cloud</p>" } } },
    ],
  },
];

// ---------- runner ----------

const keep = process.argv.includes("--keep");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "edit-site-selftest-"));
const rows = [];
let n = 0;

for (const stack of STACKS) {
  for (const c of stack.cases) {
    const dir = path.join(base, String(++n).padStart(2, "0"));
    for (const [f, body] of Object.entries(stack.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    const problems = [];
    let result;
    let root = dir;
    try {
      // Monorepo stacks start inside the app and let the project root be found, as the CLI does.
      if (stack.git) execSync("git init -q", { cwd: dir });
      if (stack.app) process.chdir(path.join(dir, stack.cwd || stack.app));
      const project = loadProject({ root: stack.app ? undefined : dir });
      root = project.root;
      if (stack.app && root !== fs.realpathSync(path.join(dir, stack.app))) problems.push(`root ${root}, expected ${stack.app}`);
      if (project.framework !== stack.framework) problems.push(`detected ${project.framework}, expected ${stack.framework}`);
      const saver = createSaver({ project, stateDir: path.join(root, ".edit-site") });
      for (const [i, step] of (c.steps || [{ edit: c.edit }]).entries()) {
        result = step.edit
          ? await saver.save({ tag: "p", nodes: [], lang: "en", ...step.edit })
          : await saver.resolve({ id: result.id, pick: step.pick });
        const w = step.expect;
        if (w && result.status !== w.status) problems.push(`step ${i + 1}: got ${result.status}, expected ${w.status}`);
        if (w?.choices && result.choices?.length !== w.choices) problems.push(`step ${i + 1}: ${result.choices?.length} choices, expected ${w.choices}`);
      }
      if (c.expect.pending != null && saver.readPending().length !== c.expect.pending) problems.push(`${saver.readPending().length} queued, expected ${c.expect.pending}`);
    } catch (e) {
      problems.push(`threw: ${e.message}`);
    }
    const want = c.expect;
    const status = want.status || "applied";
    if (want.reason && !result?.reason?.includes(want.reason)) problems.push(`reason "${result?.reason}", expected it to mention "${want.reason}"`);
    if (result && result.status !== status) problems.push(`got ${result.status} (${result.reason || result.file || ""}), expected ${status}`);
    if (result && status === "applied" && result.status === "applied") {
      if (want.file && result.file !== want.file) problems.push(`wrote ${result.file}, expected ${want.file}`);
      if (want.followUp != null && Boolean(result.followUp) !== want.followUp) problems.push(`follow-up ${Boolean(result.followUp)}, expected ${want.followUp}`);
      const body = fs.readFileSync(path.join(root, result.file), "utf8");
      const contains = want.contains || (c.edit && !c.edit.nodes ? [c.edit.element.new] : []);
      for (const s of contains) if (!body.includes(s)) problems.push(`missing ${JSON.stringify(s)}`);
    }
    for (const [f, s] of Object.entries(want.untouched || {})) {
      if (!fs.readFileSync(path.join(dir, f), "utf8").includes(s)) problems.push(`${f} was changed`);
    }
    rows.push({ stack: stack.name, name: c.name, ok: problems.length === 0, why: problems.join("; ") });
  }
}

// ---------- report ----------

const w1 = Math.max(...rows.map((r) => r.stack.length), 5);
const w2 = Math.max(...rows.map((r) => r.name.length), 4);
const line = `+${"-".repeat(w1 + 2)}+${"-".repeat(w2 + 2)}+------+`;
console.log(line);
console.log(`| ${"Stack".padEnd(w1)} | ${"Case".padEnd(w2)} | Pass |`);
console.log(line);
let last = null;
for (const r of rows) {
  if (last && last !== r.stack) console.log(line);
  console.log(`| ${(last === r.stack ? "" : r.stack).padEnd(w1)} | ${r.name.padEnd(w2)} | ${r.ok ? " ok " : "FAIL"} |`);
  last = r.stack;
}
console.log(line);
const failed = rows.filter((r) => !r.ok);
for (const r of failed) console.log(`FAIL ${r.stack} / ${r.name}: ${r.why}`);
console.log(`\n${rows.length - failed.length}/${rows.length} passed${keep ? ` (fixtures kept in ${base})` : ""}`);
process.chdir(os.tmpdir());
if (!keep) fs.rmSync(base, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
