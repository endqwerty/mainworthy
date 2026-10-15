// One page of the user documentation, from the Markdown in `docs/guide/` to the HTML the site serves.
// The Markdown stays readable where it is written (GitHub renders the same file), so a page uses no syntax of
// its own. What the site adds is decided here from ordinary Markdown: a link to another page becomes that page's
// address, a link that stands alone and points at a diagram becomes the diagram itself, and a screenshot gets its
// dark twin.
import {
	DOC_PAGES,
	DOC_SECTIONS,
	DOCS_ROOT,
	type DocPage,
	docUrl,
	isDocSlug,
	LICENCE_FILES,
	licenceFileUrl,
} from "../../core/docs.ts";

export type Heading = { id: string; text: string; level: 2 | 3 };
/** A stretch of a page under one heading: what the search finds and links to. */
export type Passage = { id: string | null; heading: string | null; text: string };
export type Article = {
	title: string;
	/** The first paragraph: the page's description, and its line on the front page. */
	lead: string;
	html: string;
	headings: Heading[];
	passages: Passage[];
	diagrams: string[];
	screenshots: string[];
	/** What the page refers to that the site cannot serve. Empty for every page that ships (`test/docs.test.ts`). */
	problems: string[];
};

export const escapeHtml = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" };
/** The words of a piece of HTML, for the search and for a title. */
export const plainText = (html: string): string =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity)
		.replace(/\s+/g, " ")
		.trim();

const CALLOUTS: Record<string, string> = {
	NOTE: "Note",
	TIP: "Tip",
	IMPORTANT: "Important",
	WARNING: "Warning",
	CAUTION: "Caution",
};

/** Where a diagram and a screenshot are served. The theme is added by the page's script when the reader chose one. */
export const diagramUrl = (name: string): string => `${DOCS_ROOT}/diagrams/${name}.html`;
export const screenshotUrl = (name: string): string => `${DOCS_ROOT}/screenshots/${name}.png`;

/**
 * A link between pages as it is written in the Markdown (`./policy.md#presets`), as the site's address; and a link
 * to a licence file at the root of the repository (`../../LICENSE`), as the address the site serves it at.
 */
function pageHref(target: string): string | null {
	const match = /^\.\/([a-z0-9-]+)\.md(?:#([A-Za-z0-9_-]+))?$/.exec(target);
	const slug = match?.[1];
	if (slug && isDocSlug(slug)) return docUrl(slug, match[2]);
	const file = LICENCE_FILES.find((name) => target === `../../${name}`);
	return file ? licenceFileUrl(file) : null;
}

export function renderArticle(source: string): Article {
	const problems: string[] = [];
	const diagrams: string[] = [];
	const screenshots: string[] = [];
	let html = Bun.markdown.html(source, { headings: { ids: true } });

	// A link alone in its paragraph that points at a diagram is the diagram, in a frame, with the link's text below.
	html = html.replace(
		/<p><a href="\.\.\/diagrams\/([a-z0-9-]+)\.html">([^<]+)<\/a><\/p>/g,
		(_all, name: string, text: string) => {
			diagrams.push(name);
			const caption = text.replace(/^Diagram:\s*/i, "").replace(/^./, (first) => first.toUpperCase());
			return [
				`<figure class="diagram">`,
				`<iframe src="${diagramUrl(name)}" title="${caption}" loading="lazy"></iframe>`,
				`<figcaption>${caption}. Zoom, search and follow a path in the frame, or <a href="${diagramUrl(name)}" target="_blank" rel="noopener">open it full screen</a>.</figcaption>`,
				`</figure>`,
			].join("");
		},
	);

	// A screenshot is written once, in its light theme. The page shows the one that matches the reader's theme.
	html = html.replace(
		/<p><img src="\.\.\/ui\/screenshots\/([a-z0-9-]+)-light\.png" alt="([^"]*)" \/><\/p>/g,
		(_all, name: string, alt: string) => {
			screenshots.push(`${name}-light`, `${name}-dark`);
			return [
				`<figure class="shot">`,
				`<img class="only-light" src="${screenshotUrl(`${name}-light`)}" alt="${alt}" loading="lazy" />`,
				`<img class="only-dark" src="${screenshotUrl(`${name}-dark`)}" alt="${alt}" loading="lazy" />`,
				`<figcaption>${alt}</figcaption>`,
				`</figure>`,
			].join("");
		},
	);

	html = html.replace(/<a href="([^"]*)"/g, (all, target: string) => {
		// A heading of this page, or what the two rules above already wrote.
		if (target.startsWith("#") || target.startsWith(`${DOCS_ROOT}/`)) return all;
		if (/^https?:\/\//.test(target)) return `<a href="${target}" rel="noopener noreferrer"`;
		const href = pageHref(target);
		if (href) return `<a href="${href}"`;
		problems.push(
			`a link to ${target}: a page links to another page (./name.md), a licence file (../../LICENSE), a diagram or an https address`,
		);
		return all;
	});
	for (const match of html.matchAll(/<img src="(?!\/docs\/)([^"]*)"/g))
		problems.push(`an image at ${match[1]}: a page shows a screenshot from ../ui/screenshots, alone in its paragraph`);

	html = html.replace(/<blockquote>\s*<p>\[!([A-Z]+)\]\s*/g, (all, kind: string) =>
		CALLOUTS[kind]
			? `<blockquote class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${CALLOUTS[kind]}</p><p>`
			: all,
	);
	html = html.replaceAll("<table>", '<div class="table-wrap"><table>').replaceAll("</table>", "</table></div>");

	const headings: Heading[] = [];
	html = html.replace(/<h([23]) id="([^"]+)">(.*?)<\/h\1>/gs, (_all, level: string, id: string, inner: string) => {
		headings.push({ id, text: plainText(inner), level: level === "2" ? 2 : 3 });
		return `<h${level} id="${id}">${inner} <a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`;
	});

	const title = plainText(/<h1[^>]*>(.*?)<\/h1>/s.exec(html)?.[1] ?? "");
	if (!title) problems.push("no title: a page starts with one # heading");
	const lead = plainText(/<\/h1>\s*<p>(.*?)<\/p>/s.exec(html)?.[1] ?? "");
	if (!lead) problems.push("no lead: the title is followed by a paragraph that says what the page is for");

	return { title, lead, html, headings, passages: passagesOf(html), diagrams, screenshots, problems };
}

/** The page cut at its headings, each piece as plain words. */
function passagesOf(html: string): Passage[] {
	const words = html.replace(/<figure[\s\S]*?<\/figure>/g, " ").replace(/<h1[\s\S]*?<\/h1>/, " ");
	const cuts = [...words.matchAll(/<h[23] id="([^"]+)">(.*?)<\/h[23]>/gs)];
	const passages: Passage[] = [];
	const push = (id: string | null, heading: string | null, from: number, to: number): void => {
		const text = plainText(words.slice(from, to));
		if (text || heading) passages.push({ id, heading, text });
	};
	push(null, null, 0, cuts[0]?.index ?? words.length);
	cuts.forEach((cut, index) => {
		const heading = plainText((cut[2] ?? "").replace(/<a class="anchor"[\s\S]*?<\/a>/, ""));
		push(cut[1] ?? null, heading, cut.index + cut[0].length, cuts[index + 1]?.index ?? words.length);
	});
	return passages;
}

// ── The page around an article ──────────────────────────────────────────────────────────────────────────────

/** The gate and its check, as in the app's header (`src/web/icon.svg`). */
const MARK =
	'<svg viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 50V17H51V50"/><path d="M23 36L30 43L42 28"/></svg>';

function navigation(current: DocPage | null): string {
	return DOC_SECTIONS.map(
		(section) =>
			`<div class="nav-section"><div class="nav-title">${escapeHtml(section.title)}</div><ul class="nav-list">${section.pages
				.map(
					(page) =>
						`<li><a href="${docUrl(page.slug)}"${page.slug === current?.slug ? ' aria-current="page"' : ""}>${escapeHtml(page.title)}</a></li>`,
				)
				.join("")}</ul></div>`,
	).join("");
}

function contents(headings: readonly Heading[]): string {
	if (headings.length < 2) return "";
	return `<aside class="toc" aria-label="On this page"><div class="nav-title">On this page</div><ul class="nav-list">${headings
		.map((heading) => `<li class="toc-${heading.level}"><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
		.join("")}</ul></aside>`;
}

function pager(current: DocPage): string {
	const index = DOC_PAGES.findIndex((page) => page.slug === current.slug);
	const link = (page: DocPage | undefined, rel: "prev" | "next", label: string): string =>
		page
			? `<a class="pager-${rel}" rel="${rel}" href="${docUrl(page.slug)}"><span>${label}</span><b>${escapeHtml(page.title)}</b></a>`
			: "<span></span>";
	return `<nav class="pager" aria-label="Previous and next page">${link(DOC_PAGES[index - 1], "prev", "Previous")}${link(DOC_PAGES[index + 1], "next", "Next")}</nav>`;
}

/**
 * A whole document: the article with the site's header, the list of pages, the list of headings and the links to
 * the pages before and after. `page` is null for the page that says an address is not a page.
 */
export function renderDocument(input: {
	page: DocPage | null;
	title: string;
	lead: string;
	html: string;
	headings: readonly Heading[];
	version: string;
}): string {
	const { page, version } = input;
	const heading = page?.slug === "index" ? "Mainworthy docs" : `${input.title} · Mainworthy docs`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(heading)}</title>
<meta name="description" content="${escapeHtml(input.lead)}" />
<link rel="icon" type="image/svg+xml" href="${DOCS_ROOT}/assets/icon.svg" />
<link rel="stylesheet" href="${DOCS_ROOT}/assets/site.css" />
<script src="${DOCS_ROOT}/assets/site.js"></script>
</head>
<body>
<a class="skip" href="#content">Skip to the page</a>
<header class="top">
<button type="button" class="menu" aria-label="Pages" aria-expanded="false" aria-controls="pages">☰</button>
<a class="brand" href="${DOCS_ROOT}"><span class="logo">${MARK}</span><b>Mainworthy</b><span class="brand-docs">Docs</span></a>
<div class="search" role="search">
<input id="search" type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false" aria-controls="search-results" />
<kbd>/</kbd>
<div id="search-results" class="search-results" role="listbox" aria-label="Search results" hidden></div>
</div>
<a class="to-app" href="/">Open Mainworthy</a>
<button type="button" class="theme" aria-label="Toggle theme">◐</button>
</header>
<div class="layout">
<nav id="pages" class="side" aria-label="Documentation">${navigation(page)}</nav>
<main id="content">
<article>${input.html}</article>
${page ? pager(page) : ""}
<footer class="foot">Mainworthy ${escapeHtml(version)}${page ? ` · this page is <code>docs/guide/${page.slug}.md</code> in the repository` : ""}</footer>
</main>
${contents(input.headings)}
</div>
</body>
</html>
`;
}
