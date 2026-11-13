/**
 * A tutorial site, printed as a book the ingest already reads (#30).
 *
 * throughline counts everything in PDF pages: units, passages, quiz anchors,
 * the reader, progress. A course that lives on the web gets in by becoming a
 * PDF, not by teaching the engine a second coordinate system.
 *
 * Nothing in here knows about any one site. Point it at the page that lists
 * the lessons and it works out the rest the way ingest works out a book:
 *
 * - **Lessons** are the largest group of same-site links that share a URL
 *   directory. **The table of contents** is the smallest element holding all
 *   of them.
 * - **A row** is the largest element around a lesson link that holds no other
 *   lesson link. Text inside the table that sits in no row is a chapter heading.
 * - **A lesson's text** is what Mozilla Readability picks as the article.
 *   Comments, sidebars, ads and navigation fall away. Content the page hides
 *   behind a toggle (quiz solutions) is shown first, because the author wrote it.
 *
 * The output is only the site's own text. The tool adds structure the site
 * already states: a divider page per chapter, a bookmark outline in the
 * index's order, and `/PageLabels` that name the lesson. No sentence is written
 * here, so the no-drift rule holds: the page images *are* the author's words.
 *
 * Fetching is temporary scaffolding. Pages are cached under the OS temp
 * directory so a re-print doesn't re-fetch. They are fetched one at a time
 * with a pause between requests. Nothing lands in the repo.
 *
 *   npm run site -- <index-url>
 *   npm run site -- <index-url> --chapters 1,2      # a quick look at the first two
 *   npm run site -- <index-url> --skip deprecated   # drop chapters whose title matches
 *   npm run site -- <index-url> --out ~/Desktop/x.pdf
 *   npm run site -- <index-url> --toc               # print what was detected, and stop
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFRef } from "pdf-lib";
import Prism from "prismjs";
import loadLanguages from "prismjs/components/index.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const USER_AGENT = "Mozilla/5.0 (compatible; throughline personal offline copy)";
const PAUSE_MS = 1500;
const MIN_LESSONS = 8;

const args = process.argv.slice(2);
const indexUrl = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const pick = flag("--chapters")?.split(",").map(Number);
const skip = flag("--skip");
const outArg = flag("--out");

if (!indexUrl) {
  console.error("usage: npm run site -- <index-url> [--chapters 1,2] [--skip <regex>] [--out file.pdf]");
  process.exit(1);
}
const site = new URL(indexUrl);
const WORK = join(tmpdir(), "throughline-sites", site.host);
const CACHE = join(WORK, "cache");

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

interface Lesson {
  url: string;
  /** The row's text in the table of contents. Used only when the page has no `h1`. */
  listed: string;
}

interface Chapter {
  /** The heading's text blocks, in order: `["Chapter 3", "Loops"]`. Empty before the first heading. */
  heading: string[];
  lessons: Lesson[];
}

// ---------------------------------------------------------------- fetching

let lastFetch = 0;

async function fetchCached(url: string): Promise<{ html: string; fetchedAt: Date }> {
  const file = join(CACHE, `${createHash("sha1").update(url).digest("hex").slice(0, 16)}.html`);
  if (existsSync(file)) return { html: await readFile(file, "utf8"), fetchedAt: (await stat(file)).mtime };

  const wait = lastFetch + PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();

  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const html = await response.text();
  await writeFile(file, html);
  return { html, fetchedAt: new Date() };
}

// ---------------------------------------------------------------- reading

/**
 * A tab that parses the site's HTML but can't run it or reach out: no page
 * scripts, no requests. The DOM work below is injected by us. The `<base>` is
 * there so relative links resolve against the page they came from.
 */
async function inertTab(browser: Browser): Promise<Page> {
  const tab = await browser.newPage();
  await tab.setJavaScriptEnabled(false);
  await tab.setRequestInterception(true);
  tab.on("request", (r) => void r.abort());
  return tab;
}

async function load(tab: Page, html: string, url: string): Promise<void> {
  await tab.setContent(`<base href="${url}">${html}`, { waitUntil: "domcontentloaded" });
  // tsx compiles with esbuild's keepNames, which wraps named functions in a
  // `__name` helper. That helper doesn't exist in the page that
  // `evaluate` serialises them into.
  await tab.evaluate("globalThis.__name = (f) => f");
}

/**
 * The site's name as it gives it, for the PDF's title and filename. Pages put
 * it in their `<title>` beside their own name ("3.2 — While loops | Some Site"),
 * so it is the piece the index and a lesson have in common.
 */
async function siteName(tab: Page, lessonHtml: string): Promise<string> {
  const pieces = (html: string) =>
    (/<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? "").split(/\s+[|–—-]\s+/).map((p) => p.trim()).filter(Boolean);
  const lesson = new Set(pieces(lessonHtml));
  const index = pieces(await tab.content());
  const shared = index.find((p) => lesson.has(p));
  if (shared) return shared;
  const og = await tab.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content?.trim() ?? null,
  );
  return og || site.host;
}

async function tableOfContents(tab: Page): Promise<Chapter[]> {
  return tab.evaluate(() => {
    const here = new URL(document.baseURI);
    const resolve = (a: HTMLAnchorElement): string | null => {
      try {
        const u = new URL(a.getAttribute("href")!, document.baseURI);
        if (u.origin !== here.origin || !/^https?:$/.test(u.protocol)) return null;
        u.hash = "";
        u.search = "";
        return u.href === here.href ? null : u.href;
      } catch {
        return null;
      }
    };
    const dirOf = (url: string) => {
      const path = new URL(url).pathname.replace(/\/$/, "");
      return path.slice(0, path.lastIndexOf("/") + 1);
    };

    const anchors = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap((a) => {
      const url = resolve(a);
      return url ? [{ a, url }] : [];
    });

    // Lessons: the biggest family of same-site URLs sharing a directory.
    const families = new Map<string, Set<string>>();
    for (const { url } of anchors) {
      const dir = dirOf(url);
      if (!families.has(dir)) families.set(dir, new Set());
      families.get(dir)!.add(url);
    }
    const [lessonDir] = [...families].sort((a, b) => b[1].size - a[1].size)[0] ?? [];
    const lessonAnchors = anchors.filter((x) => dirOf(x.url) === lessonDir);
    if (lessonAnchors.length === 0) return [];

    // The table: the smallest element holding every lesson link.
    let table: Element = lessonAnchors[0].a;
    while (!lessonAnchors.every((x) => table.contains(x.a))) table = table.parentElement!;

    // A row is an element around one lesson link and no other, and every
    // lesson's row has the same shape. Climbing "as far as there's only one
    // link" overshoots on a chapter with a single lesson (the climb takes in
    // the whole chapter, heading included). So the shape is chosen across all
    // links first: the one nearly every link sits inside, taking the outermost
    // when several qualify.
    // A link in the index's prose ("start with the first lesson") has no such
    // ancestor and is not part of the table.
    const count = (el: Element) => lessonAnchors.filter((x) => el.contains(x.a)).length;
    const shape = (el: Element) => `${el.tagName}.${[...el.classList].sort().join(".")}`;
    const chains = lessonAnchors.map((x) => {
      const chain: Element[] = [x.a];
      let el = x.a.parentElement;
      while (el && el !== table && count(el) === 1) {
        chain.push(el);
        el = el.parentElement;
      }
      return { url: x.url, chain };
    });
    const tally = new Map<string, { links: number; height: number }>();
    for (const { chain } of chains) {
      const seenShapes = new Set<string>();
      chain.forEach((el, height) => {
        const key = shape(el);
        if (seenShapes.has(key)) return;
        seenShapes.add(key);
        const t = tally.get(key) ?? { links: 0, height: 0 };
        tally.set(key, { links: t.links + 1, height: t.height + height });
      });
    }
    const most = Math.max(...[...tally.values()].map((t) => t.links));
    const [rowShape] = [...tally]
      .filter(([, t]) => t.links >= most * 0.9)
      .sort((a, b) => b[1].height / b[1].links - a[1].height / a[1].links)[0];
    const rows = new Map<Element, { url: string }>();
    for (const { url, chain } of chains) {
      const row = chain.find((el) => shape(el) === rowShape);
      if (row) rows.set(row, { url });
    }

    // Walk the table in order. Rows are lessons. Loose text is heading
    // material, grouped by the block it sits in so "Chapter <em>1</em>" stays
    // one piece.
    const INLINE = /^(A|SPAN|EM|STRONG|B|I|CODE|SMALL|SUP|SUB|MARK|ABBR)$/;
    const chapters: { heading: { text: string; shape: string }[]; lessons: { url: string; listed: string }[] }[] = [];
    const seen = new Set<string>();
    let pending: { block: Element; text: string }[] = [];

    const walk = (node: Node): void => {
      if (node instanceof Element) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return;
        const row = rows.get(node);
        if (row) {
          if (seen.has(row.url)) return;
          seen.add(row.url);
          if (pending.length > 0 || chapters.length === 0) {
            const blocks: { text: string; shape: string }[] = [];
            let last: Element | null = null;
            for (const p of pending) {
              if (p.block === last) blocks[blocks.length - 1].text += ` ${p.text}`;
              else blocks.push({ text: p.text, shape: shape(p.block) });
              last = p.block;
            }
            chapters.push({ heading: blocks, lessons: [] });
            pending = [];
          }
          const listed = (node as HTMLElement).innerText.split("\n").map((s) => s.trim()).filter(Boolean).join(" ");
          chapters[chapters.length - 1].lessons.push({ url: row.url, listed });
          return;
        }
        node.childNodes.forEach(walk);
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent!.replace(/\s+/g, " ").trim();
        if (!text) return;
        let block = node.parentElement!;
        while (INLINE.test(block.tagName) && block.parentElement && block !== table) block = block.parentElement;
        pending.push({ block, text });
      }
    };
    walk(table);

    // A chapter heading looks like every other chapter heading. Text whose
    // shape turns up only once is the index's own furniture (a page title, an
    // introduction, a notice) and stays out of the outline.
    const recurring = new Map<string, number>();
    for (const c of chapters) for (const shapeOf of new Set(c.heading.map((h) => h.shape))) {
      recurring.set(shapeOf, (recurring.get(shapeOf) ?? 0) + 1);
    }
    return chapters
      .filter((c) => c.lessons.length > 0)
      .map((c) => {
        // A heading is also short: a long recurring block is a chapter's blurb, not its name.
        const kept = c.heading.filter((h) => (recurring.get(h.shape) ?? 0) >= 2 && h.text.length <= 120);
        // Two headings with nothing between them: a chapter with no lessons
        // listed. The one that owns these lessons is the last.
        const from = kept.map((h) => h.shape).lastIndexOf(kept[0]?.shape);
        return { heading: kept.slice(Math.max(0, from)).map((h) => h.text), lessons: c.lessons };
      });
  });
}

const READABILITY = await readFile(
  createRequire(import.meta.url).resolve("@mozilla/readability/Readability.js"),
  "utf8",
);

/**
 * What the article needs from the page around it to look the way it does
 * there: the site's stylesheets (linked ones by URL, inline ones by text), and
 * the chain of elements the article sat inside. Site CSS is often scoped
 * (`#main pre[class*=language-]`), and those rules only match if the article
 * is still inside a `#main`.
 */
interface SiteStyle {
  links: string[];
  inline: string[];
  /** Outermost first, `<body>` excluded. */
  frame: { tag: string; id: string; cls: string }[];
  body: { id: string; cls: string };
}

const NO_SITE: SiteStyle = { links: [], inline: [], frame: [], body: { id: "", cls: "" } };

/**
 * The lesson as the author wrote it, chosen by Readability.
 *
 * Two changes before it runs, both about controls rather than content.
 * Elements hidden inline are shown, because a "Show Solution" toggle hides
 * the author's own answer and Readability drops anything hidden. They are
 * marked so the print can frame them. Links and buttons that only run script
 * are removed, because they are the toggles themselves.
 *
 * Classes are kept, and the site's stylesheets come back with the article.
 * Sites mark structure with classes as often as with tags: a section heading
 * that is a styled `<p>`, a "Best practice" box that is a styled `<div>`.
 * Without the site's CSS those become plain paragraphs and the lesson loses
 * its shape.
 */
async function article(
  tab: Page,
  fallbackTitle: string,
): Promise<{ title: string; body: string; style: SiteStyle }> {
  const result = (await tab.evaluate(`(() => {
    ${READABILITY}
    const h1 = document.querySelector("h1")?.textContent?.replace(/\\s+/g, " ").trim() || null;
    const style = {
      links: [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map((l) => l.href),
      inline: [...document.querySelectorAll("style")].map((s) => s.textContent),
    };
    document.querySelectorAll("[style]").forEach((e) => {
      if (/display\\s*:\\s*none/i.test(e.getAttribute("style"))) {
        e.style.removeProperty("display");
        // On the children too: Readability replaces a wrapper holding a
        // single paragraph with the paragraph, and the mark would go with it.
        for (const el of [e, ...e.children]) el.classList.add("throughline-revealed");
      }
    });
    document.querySelectorAll('a[href^="javascript:"], button').forEach((e) => e.remove());
    // Readability takes the document apart, so it gets a copy. The original
    // is kept to find where the article sat.
    const parsed = new Readability(document.cloneNode(true), { keepClasses: true }).parse();
    if (!parsed) return null;

    const holder = document.createElement("div");
    holder.innerHTML = parsed.content;
    const root = holder.firstElementChild?.firstElementChild;
    let found = null;
    if (root) {
      const same = (el) =>
        el.tagName === root.tagName && el.id === root.id && el.className === root.className;
      found = [...document.body.getElementsByTagName(root.tagName)].find(same) ?? null;
    }
    style.frame = [];
    for (let el = found?.parentElement; el && el !== document.body; el = el.parentElement) {
      style.frame.unshift({ tag: el.tagName.toLowerCase(), id: el.id, cls: el.className });
    }
    style.body = { id: document.body.id, cls: document.body.className };
    return { h1, style, content: parsed.content };
  })()`)) as { h1: string | null; style: SiteStyle; content: string } | null;
  if (!result) throw new Error("Readability found no article on this page");

  const title = result.h1 ?? fallbackTitle;
  // Readability's wrapper is `<div class="page">`, and `.page` is a class
  // sites style for their own layout (some give it a background).
  const content = result.content.replace(/(<div id="readability-page-1")\s+class="page"/, "$1");
  // The heading is printed by us. Drop the article's copy so it doesn't appear twice.
  const body = content.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/i, (whole, inner: string) =>
    inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() === title ? "" : whole,
  );
  return { title, body, style: result.style };
}

// ---------------------------------------------------------------- printing

/**
 * Book-like proportions: narrow enough to sit beside the unit pane, wide
 * enough that most listings don't wrap. Long lines wrap instead of running
 * off the page, because a clipped line of code loses the author's text.
 */
const PAGE_IN = { width: 7, height: 9.5 };
const MARGIN_IN = { top: 0.65, side: 0.7, bottom: 0.75 };
/** The column the text is set in: the page less its side margins. */
const PRINT_WIDTH_IN = PAGE_IN.width - 2 * MARGIN_IN.side;

const STYLE = `
  @page { size: ${PAGE_IN.width}in ${PAGE_IN.height}in; margin: ${MARGIN_IN.top}in ${MARGIN_IN.side}in ${MARGIN_IN.bottom}in; }
  html { font: 10.5pt/1.45 Charter, Georgia, serif; color: #111; }
  html, body { background: #fff !important; }
  body { margin: 0 !important; padding: 0 !important; }
  h1 { font-size: 17pt; line-height: 1.2; margin: 0 0 1em; }
  h2, h3, h4 { font-size: 12.5pt; line-height: 1.3; margin: 1.3em 0 0.5em; break-after: avoid; }
  p { margin: 0 0 0.7em; }
  a { color: inherit; text-decoration: none; }
  pre, code, kbd, samp { font-family: Menlo, Consolas, monospace; }
  code { font-size: 0.9em; }
  pre { background: #f5f5f3; padding: 0.5em 0.7em; margin: 0 0 0.9em; }
  /* Listings keep the site's colours, font and gutter, but not its size or its
     overflow. A screen column is wider than this page, and a listing that
     scrolls on screen is clipped on paper, which loses the author's text. */
  pre, pre * { font-size: 8.3pt !important; line-height: 1.4 !important; }
  pre, pre > code { white-space: pre-wrap !important; overflow-wrap: anywhere !important;
                    max-height: none !important; }
  /* Chrome can't split a box that scrolls or clips (overflow other than
     visible) across pages, and screen CSS uses overflow freely. Such a box
     jumps whole to the next page and leaves a gap. If it's taller than a page,
     it gets sliced through a line. The same goes for break-inside: avoid on a
     long table. On paper nothing scrolls, so everything is allowed to break
     and nothing is clipped. */
  .throughline-frame, #readability-page-1, #readability-page-1 * {
    overflow: visible !important; break-inside: auto !important; }
  p, li, pre { orphans: 3; widows: 3; }
  /* The site's layout around the article is overruled too: on screen it is a
     column beside a sidebar, and here the page is the column. */
  .throughline-frame, #readability-page-1, #readability-page-1 > div {
    background: none !important; border: 0 !important; box-shadow: none !important;
    padding: 0 !important; margin: 0 !important; max-width: none !important; width: auto !important;
    min-width: 0 !important; float: none !important; position: static !important;
    display: block !important; columns: auto !important; transform: none !important; }
  blockquote { border-left: 2px solid #ccc; margin: 0 0 0.9em; padding-left: 0.8em; }
  table { border-collapse: collapse; margin: 0 0 0.9em; font-size: 9pt; }
  td, th { border: 1px solid #bbb; padding: 0.2em 0.5em; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  ul, ol { margin: 0 0 0.7em; padding-left: 1.4em; }
  .divider { height: 7.5in; display: flex; flex-direction: column; justify-content: center; }
  /* A numbered listing: each line a block with its own number in the margin
     beside it, so numbers can't drift from their lines across a page break. */
  pre.throughline-numbered, pre.throughline-numbered > code { padding-left: 0 !important; display: block !important; }
  pre.throughline-numbered > code { counter-reset: throughline-line; }
  pre.throughline-numbered .line-numbers-rows { display: none !important; }
  .throughline-line { display: block; position: relative; margin-left: 3.4em; padding-left: 0.8em;
                      border-left: 1px solid #c8c8c8; min-height: 1.4em; }
  .throughline-line::before { counter-increment: throughline-line; content: counter(throughline-line);
                              position: absolute; right: calc(100% + 0.7em); color: #999;
                              /* Listings may break anywhere (below); a number must not, or
                                 an absolutely placed "36" stacks its digits on one spot. */
                              white-space: nowrap !important; overflow-wrap: normal !important; }
  .throughline-revealed { display: block !important; border-left: 2px dashed #999; padding-left: 0.7em; }
  .throughline-revealed .throughline-revealed { border-left: 0; padding-left: 0; }
  .divider .label { font-size: 13pt; letter-spacing: 0.08em; text-transform: uppercase; color: #555; }
  .divider h1 { font-size: 24pt; margin-top: 0.3em; }
`;

/**
 * Prism's own light theme and line-number gutter, for a site that doesn't
 * style highlighted code itself. It goes first, so a site that does wins.
 */
const PRISM_CSS = (
  await Promise.all(
    ["prismjs/themes/prism.css", "prismjs/plugins/line-numbers/prism-line-numbers.css"].map((f) =>
      readFile(createRequire(import.meta.url).resolve(f), "utf8"),
    ),
  )
).join("\n");

/** Prism's defaults first, then the site's CSS, then ours, so page size, type and wrapping are ours. */
function page(body: string, base: string, site: SiteStyle = NO_SITE): string {
  const theirs =
    site.links.map((href) => `<link rel=stylesheet href="${escapeHtml(href)}">`).join("") +
    site.inline.map((css) => `<style>${css.replace(/<\/style/gi, "")}</style>`).join("");
  const attr = (name: string, value: string) => (value ? ` ${name}="${escapeHtml(value)}"` : "");
  const framed = site.frame.reduceRight(
    (inner, f) => `<${f.tag}${attr("id", f.id)} class="${escapeHtml(`${f.cls} throughline-frame`.trim())}">${inner}</${f.tag}>`,
    body,
  );
  return (
    `<!doctype html><html><head><meta charset=utf-8><base href="${base}">` +
    `<style>${PRISM_CSS}</style>${theirs}<style>${STYLE}</style></head>` +
    `<body${attr("id", site.body.id)}${attr("class", site.body.cls)}>${framed}</body></html>`
  );
}

/**
 * Images, stylesheets and fonts. No scripts and no frames, which are most of
 * what a page that runs on ads would otherwise pull in.
 */
async function printTab(browser: Browser): Promise<Page> {
  const tab = await browser.newPage();
  // Laid out the way it will print, before it prints: anything measured on
  // the page (listing rows, below) must be measured at the printed width,
  // not at a desktop window's.
  await tab.setViewport({ width: Math.round(PRINT_WIDTH_IN * 96), height: 1200 });
  await tab.emulateMediaType("print");
  await tab.setJavaScriptEnabled(false);
  await tab.setRequestInterception(true);
  tab.on("request", (r) => {
    const ok = ["document", "image", "stylesheet", "font"].includes(r.resourceType());
    void (ok ? r.continue() : r.abort());
  });
  return tab;
}

/**
 * The footer prints the same string that `/PageLabels` gives the sheet. That
 * way the number in a citation and the number on the page always agree, which
 * is the rule `lib/printed.ts` is built on.
 */
async function print(tab: Page, html: string, folioPrefix: string | null): Promise<Uint8Array> {
  // `load` already waits for the images. `networkidle0` never fires for a
  // `setContent` document on current Chrome and times out instead.
  await tab.setContent(html, { waitUntil: "load", timeout: 60_000 });
  await highlight(tab);
  await letBreak(tab);
  return tab.pdf({
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: folioPrefix !== null,
    headerTemplate: "<span></span>",
    footerTemplate:
      folioPrefix === null
        ? "<span></span>"
        : `<div style="width:100%;font:8pt Charter,Georgia,serif;color:#666;text-align:center">${escapeHtml(folioPrefix)}<span class=pageNumber></span></div>`,
  });
}

// ---------------------------------------------------------------- listings

/**
 * Sites colour their code in the browser, with a script that never runs
 * here, so a listing arrives as plain text. It is coloured at print time
 * instead, with Prism, in whatever language the page declares
 * (`language-cpp` / `lang-cpp`, the convention Prism, highlight.js and most
 * Markdown renderers share). Prism's token classes are what most sites' code
 * themes target, so the site's own colours apply when it has them.
 *
 * Line numbers are drawn only where the page asks for them with Prism's
 * `line-numbers` class. A gutter on the program's output would be noise.
 * Each source line becomes its own block carrying its own number, instead of
 * Prism's separate gutter column. On paper a column and the code beside it
 * break across pages at different points, and every number after the break
 * lands beside the wrong line. A number that belongs to its line can't drift,
 * and a wrapped line keeps one number without anything being measured.
 *
 * Only presentation changes: the text inside every `<pre>` is untouched,
 * character for character.
 */
async function highlight(tab: Page): Promise<void> {
  const blocks = await tab.evaluate(() =>
    [...document.querySelectorAll("pre")].map((pre) => {
      pre.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      const code = pre.querySelector(":scope > code");
      const classes = `${pre.className} ${code?.className ?? ""}`;
      return {
        lang: /\b(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1]?.toLowerCase() ?? null,
        numbered: /\bline-numbers\b/.test(classes),
        text: pre.textContent ?? "",
      };
    }),
  );
  if (blocks.length === 0) return;

  const html = blocks.map((b) => {
    const grammar = b.lang ? grammarFor(b.lang) : null;
    if (!grammar && !b.numbered) return null;
    const coloured = grammar ? Prism.highlight(b.text, grammar, b.lang!) : escapeHtml(b.text);
    return b.numbered ? numberedLines(coloured) : coloured;
  });

  await tab.evaluate(
    (blocks, html) => {
      [...document.querySelectorAll("pre")].forEach((pre, i) => {
        const b = blocks[i];
        if (!b || !html[i]) return;
        let code = pre.querySelector(":scope > code");
        if (!code) {
          code = document.createElement("code");
          pre.replaceChildren(code);
        }
        if (b.lang) {
          pre.classList.add(`language-${b.lang}`);
          code.classList.add(`language-${b.lang}`);
        }
        if (b.numbered) pre.classList.add("line-numbers", "throughline-numbered");
        code.innerHTML = html[i]!;
      });
    },
    blocks,
    html,
  );
}

/**
 * Highlighted HTML cut into one block per source line.
 *
 * A token can span lines (a block comment, a raw string), so a cut can fall
 * inside an open `<span>`. Every span open at a newline is closed before it
 * and reopened after it, so each line is well-formed and keeps its colour.
 * Prism's output has only `<span class=…>`, `</span>` and escaped text, which
 * is what makes this a tag stack rather than a parser. A trailing newline
 * doesn't start a line (Prism's own count).
 */
function numberedLines(html: string): string {
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const part of html.replace(/\n$/, "").split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (part.startsWith("<span")) open.push(part);
      else if (part === "</span>") open.pop();
      line += part;
    }
  }
  lines.push(line);
  return lines.map((l) => `<span class="throughline-line">${l}</span>`).join("");
}

/**
 * An inline-block can't be split across pages. Sites use them for full-width
 * boxes (a listing's `<code>`, a table's wrapper) because on screen it
 * doesn't matter. On paper a short one jumps to the next page and leaves half
 * a page blank, and a long one is sliced through a line of text. Anything
 * spanning the column is made a block, which looks the same and can break.
 */
async function letBreak(tab: Page): Promise<void> {
  await tab.evaluate(() => {
    const column = document.body.clientWidth;
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      const display = getComputedStyle(el).display;
      if ((display === "inline-block" || display === "inline-flex") && el.offsetWidth >= column * 0.9) {
        el.style.setProperty("display", display === "inline-flex" ? "flex" : "block", "important");
      }
    }
  });
}

const grammars = new Map<string, Prism.Grammar | null>();

/** Prism's grammar for a language name or alias, loaded on first use; null when Prism has none. */
function grammarFor(lang: string): Prism.Grammar | null {
  if (!grammars.has(lang)) {
    try {
      loadLanguages([lang]);
    } catch {
      // An unknown name is a plain listing, not an error.
    }
    grammars.set(lang, Prism.languages[lang] ?? null);
  }
  return grammars.get(lang)!;
}

// Prism's highlight-keywords plugin, which themes use to colour `return` apart
// from `int`: every keyword token also carries `keyword-<the keyword>`.
Prism.hooks.add("wrap", (env) => {
  if (env.type === "keyword") env.classes.push(`keyword-${env.content}`);
});

// ---------------------------------------------------------------- the PDF's own structure

interface Mark {
  title: string;
  /** 0-based page index in the merged document. */
  page: number;
  children: Mark[];
}

/** The bookmark outline, written by hand because pdf-lib has no API for it. */
function writeOutline(pdf: PDFDocument, marks: Mark[]): void {
  const pages = pdf.getPages();
  const rootRef = pdf.context.nextRef();

  const build = (items: Mark[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = items.map(() => pdf.context.nextRef());
    items.forEach((item, i) => {
      const dict = pdf.context.obj({}) as PDFDict;
      dict.set(PDFName.of("Title"), PDFHexString.fromText(item.title));
      dict.set(PDFName.of("Parent"), parent);
      const dest = PDFArray.withContext(pdf.context);
      dest.push(pages[item.page].ref);
      dest.push(PDFName.of("Fit"));
      dict.set(PDFName.of("Dest"), dest);
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < items.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      if (item.children.length > 0) {
        const kids = build(item.children, refs[i]);
        dict.set(PDFName.of("First"), kids.first);
        dict.set(PDFName.of("Last"), kids.last);
        // Negative means collapsed: a viewer opens on the chapters, not on every lesson.
        dict.set(PDFName.of("Count"), PDFNumber.of(-kids.count));
      }
      pdf.context.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], count: items.length };
  };

  const top = build(marks, rootRef);
  pdf.context.assign(
    rootRef,
    pdf.context.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: PDFNumber.of(top.count) }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);
}

interface LabelRange {
  start: number;
  prefix: string;
  numbered: boolean;
}

function writePageLabels(pdf: PDFDocument, ranges: LabelRange[]): void {
  const nums = PDFArray.withContext(pdf.context);
  for (const r of ranges) {
    nums.push(PDFNumber.of(r.start));
    const label = pdf.context.obj({}) as PDFDict;
    label.set(PDFName.of("P"), PDFHexString.fromText(r.prefix));
    if (r.numbered) label.set(PDFName.of("S"), PDFName.of("D"));
    nums.push(label);
  }
  pdf.catalog.set(PDFName.of("PageLabels"), pdf.context.obj({ Nums: nums }));
}

/**
 * What a lesson calls itself, if it numbers itself: the `3.2` in "3.2 — While
 * loops" or the `B.1` in "B.1 — Glossary". A number needs a dot and a
 * digit, so "Node.js basics" doesn't count. Otherwise the lesson gets its
 * position, chapter.lesson.
 */
function lessonNumber(title: string, chapter: number, lesson: number): string {
  const m = /^([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)+)(?=\s|$)/.exec(title);
  return m && /\d/.test(m[1]) ? m[1] : `${chapter}.${lesson}`;
}

// ---------------------------------------------------------------- main

await mkdir(CACHE, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const inert = await inertTab(browser);
  const printer = await printTab(browser);

  const index = await fetchCached(site.href);
  await load(inert, index.html, site.href);
  let toc = await tableOfContents(inert);
  // A handful of same-directory links is an index's prose pointing at a few
  // pages, not a course. That is what a site whose table of contents is built
  // by JavaScript looks like with scripts off, and it is refused here instead
  // of printed as a four-lesson book.
  const found = toc.reduce((n, c) => n + c.lessons.length, 0);
  if (found < MIN_LESSONS) {
    throw new Error(
      `found ${found} lesson links on ${site.href}, not a table of contents. If the site builds its ` +
        `contents with JavaScript, point this at a page that lists the lessons in its HTML.`,
    );
  }
  const name = await siteName(inert, (await fetchCached(toc[0].lessons[0].url)).html);

  if (args.includes("--toc")) {
    for (const [i, c] of toc.entries()) {
      console.log(`${i + 1}. ${c.heading.join(" — ") || "(no heading)"}  [${c.lessons.length} lessons]`);
      for (const l of c.lessons) console.log(`     ${l.listed}`);
    }
    process.exit(0);
  }

  const headed = toc.some((c) => c.heading.length > 0);
  if (pick) toc = toc.filter((_, i) => pick.includes(i + 1));
  if (skip) toc = toc.filter((c) => !new RegExp(skip, "i").test(c.heading.join(" ")));

  const total = toc.reduce((n, c) => n + c.lessons.length, 0);
  console.log(`${name}: ${toc.length} chapters, ${total} lessons${headed ? "" : " (no chapter headings found, flat outline)"}`);

  const merged = await PDFDocument.create();
  const marks: Mark[] = [];
  const labels: LabelRange[] = [];
  let done = 0;

  for (const [c, chapter] of toc.entries()) {
    // Lessons before the first heading, or on a site with none, hang at the top level.
    let siblings = marks;
    if (chapter.heading.length > 0) {
      const title = chapter.heading.join(" — ");
      const label = chapter.heading[0].length <= 16 ? chapter.heading[0] : `Ch. ${c + 1}`;
      const mark: Mark = { title, page: merged.getPageCount(), children: [] };
      labels.push({ start: merged.getPageCount(), prefix: label, numbered: false });
      const [first, ...rest] = chapter.heading;
      const divider = rest.length
        ? `<div class=divider><div class=label>${escapeHtml(first)}</div><h1>${escapeHtml(rest.join(" — "))}</h1></div>`
        : `<div class=divider><h1>${escapeHtml(first)}</h1></div>`;
      await append(merged, await print(printer, page(divider, site.href), null));
      marks.push(mark);
      siblings = mark.children;
    }

    for (const [l, lesson] of chapter.lessons.entries()) {
      const { html } = await fetchCached(lesson.url);
      await load(inert, html, lesson.url);
      const { title, body, style } = await article(inert, lesson.listed);
      const prefix = `${lessonNumber(title, c + 1, l + 1)}·`;
      const start = merged.getPageCount();
      await append(merged, await print(printer, page(`<h1>${escapeHtml(title)}</h1>${body}`, lesson.url, style), prefix));
      siblings.push({ title, page: start, children: [] });
      labels.push({ start, prefix, numbered: true });
      done += 1;
      process.stdout.write(`\r${done}/${total}  ${merged.getPageCount()} pages`);
    }
  }
  process.stdout.write("\n");

  writeOutline(merged, marks);
  writePageLabels(merged, labels);
  merged.setTitle(name);
  merged.setAuthor(site.host);
  merged.setSubject(`${site.href} (personal offline copy, fetched ${index.fetchedAt.toISOString().slice(0, 10)})`);
  merged.setProducer("throughline tools/site-to-pdf.ts");
  merged.setCreator("throughline tools/site-to-pdf.ts");
  // Pinned to the index fetch, not to now. Books are identified by the sha256
  // of their bytes, so re-printing the same cache must not shelve a second copy.
  merged.setCreationDate(index.fetchedAt);
  merged.setModificationDate(index.fetchedAt);

  const out = outArg ?? join(WORK, `${name.replace(/[/\\:]/g, "-")}.pdf`);
  const bytes = await merged.save();
  await writeFile(out, bytes);
  console.log(`${out}\n${merged.getPageCount()} pages, ${(bytes.length / 1e6).toFixed(1)} MB`);
} finally {
  await browser.close();
}

async function append(into: PDFDocument, bytes: Uint8Array): Promise<void> {
  const part = await PDFDocument.load(bytes);
  for (const p of await into.copyPages(part, part.getPageIndices())) into.addPage(p);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
