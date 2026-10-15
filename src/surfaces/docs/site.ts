// The documentation site: `/docs` and everything under it. It is built from the files in `content.ts` and from
// nothing else. It is not given the instance, so it cannot show a project's name, a person or a setting: the
// same pages for every instance of a version, which is why they need no session (`serve` in `../http.ts`).
import { z } from "zod";
import { DOC_PAGES, DOCS_ROOT, type DocPage, docUrl, isDocSlug } from "../../core/docs.ts";
import { type Article, escapeHtml, renderArticle, renderDocument } from "./render.ts";

/**
 * A page runs the site's own script and style sheet and nothing written into the page, loads its pictures and
 * diagrams from this server, and is framed by nobody else.
 */
const PAGE_POLICY = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self'",
	"frame-src 'self'",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join("; ");

/**
 * A diagram is a page with its script and styles inside it, made by a tool. It is served as a stranger to this
 * server: `sandbox` without `allow-same-origin` gives it an origin of its own, so its script cannot read the
 * app's storage or call the API as the person looking at it, and it may load nothing from anywhere.
 */
const DIAGRAM_POLICY = [
	"sandbox allow-scripts allow-downloads",
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src blob:",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join("; ");

const ASSET_POLICY = "default-src 'none'; frame-ancestors 'none'";

/**
 * A diagram page records which files each of its parts was drawn from, and the address of the repository they
 * are in. The files stay: they say what a part stands for. The address is replaced by the product's name: the
 * site is read by people who have no business with whose repository it is, and the link could not be opened.
 */
export function withoutRepositoryAddress(html: string): string {
	return html.replace(
		/(<script id="archify-source-evidence-data" type="application\/json">)([\s\S]*?)(<\/script>)/,
		(all, open: string, json: string, close: string) => {
			// Data that cannot be read is left as it is, and the page with it: one bad diagram does not take the
			// site down. `test/docs.test.ts` holds every page that ships to carrying no address.
			let data: unknown;
			try {
				data = JSON.parse(json);
			} catch {
				return all;
			}
			const evidence = z.looseObject({ repository: z.looseObject({}) }).safeParse(data);
			if (!evidence.success) return all;
			const repository = { ...evidence.data.repository, url: "mainworthy", label: "mainworthy" };
			// As archify writes it: a `<` inside the JSON must not end the script element.
			return `${open}${JSON.stringify({ ...evidence.data, repository }).replaceAll("<", "\\u003c")}${close}`;
		},
	);
}

type Entry = {
	status: number;
	type: string;
	policy: string;
	body: Uint8Array<ArrayBuffer>;
	etag: string;
	gzip: Uint8Array<ArrayBuffer> | null;
};

const encoder = new TextEncoder();

function entry(input: {
	body: string | Uint8Array<ArrayBuffer>;
	type: string;
	policy: string;
	status?: number;
}): Entry {
	const body = typeof input.body === "string" ? encoder.encode(input.body) : input.body;
	const compressible = !input.type.startsWith("image/png") && input.type !== GZIP && body.byteLength > 1024;
	return {
		status: input.status ?? 200,
		type: input.type,
		policy: input.policy,
		body,
		etag: `"${Bun.hash(body).toString(36)}"`,
		gzip: compressible ? Bun.gzipSync(body) : null,
	};
}

const HTML = "text/html; charset=utf-8";
const GZIP = "application/gzip";

/** Where the agent skill is served: one archive of the directory `mainworthy`, which `tar -xz` unpacks. */
export const SKILL_URL = `${DOCS_ROOT}/skill/mainworthy.tar.gz`;

/** One line of the search: a heading of a page, the words under it, and where it is. */
export type SearchEntry = { url: string; page: string; section: string; heading: string | null; text: string };

export type Site = {
	articles: ReadonlyMap<DocPage, Article>;
	search: SearchEntry[];
	entries: ReadonlyMap<string, Entry>;
	missing: Entry;
};

/**
 * Renders every page once. Nothing here depends on a request. The files are read here and not when the server
 * starts: they are several megabytes, and most starts (every server a test makes) are never asked for a page.
 */
export async function buildSite(version: string): Promise<Site> {
	const { DIAGRAMS, ICON, PAGES, SCREENSHOTS, SCRIPT, SKILL, STYLES } = await import("./content.ts");
	const articles = new Map(DOC_PAGES.map((page) => [page, renderArticle(PAGES[page.slug])] as const));
	const entries = new Map<string, Entry>();
	const search: SearchEntry[] = [];
	for (const [page, article] of articles) {
		const document = renderDocument({ page, ...article, version });
		entries.set(docUrl(page.slug), entry({ body: document, type: HTML, policy: PAGE_POLICY }));
		for (const passage of article.passages) {
			search.push({
				url: docUrl(page.slug, passage.id ?? undefined),
				page: page.title,
				section: page.section,
				heading: passage.heading,
				text: passage.text,
			});
		}
	}
	for (const [name, html] of Object.entries(DIAGRAMS))
		entries.set(
			`${DOCS_ROOT}/diagrams/${name}.html`,
			entry({ body: withoutRepositoryAddress(html), type: HTML, policy: DIAGRAM_POLICY }),
		);
	for (const [name, path] of Object.entries(SCREENSHOTS)) {
		const body = await Bun.file(path).bytes();
		entries.set(`${DOCS_ROOT}/screenshots/${name}.png`, entry({ body, type: "image/png", policy: ASSET_POLICY }));
	}
	entries.set(
		`${DOCS_ROOT}/assets/site.css`,
		entry({ body: STYLES, type: "text/css; charset=utf-8", policy: ASSET_POLICY }),
	);
	entries.set(
		`${DOCS_ROOT}/assets/site.js`,
		entry({ body: SCRIPT, type: "text/javascript; charset=utf-8", policy: ASSET_POLICY }),
	);
	entries.set(`${DOCS_ROOT}/assets/icon.svg`, entry({ body: ICON, type: "image/svg+xml", policy: ASSET_POLICY }));
	const skill = new Bun.Archive(
		Object.fromEntries(Object.entries(SKILL).map(([path, text]) => [`mainworthy/${path}`, text])),
		{ compress: "gzip" },
	);
	entries.set(SKILL_URL, entry({ body: await skill.bytes(), type: GZIP, policy: ASSET_POLICY }));
	entries.set(
		`${DOCS_ROOT}/search.json`,
		entry({ body: JSON.stringify(search), type: "application/json; charset=utf-8", policy: ASSET_POLICY }),
	);
	const missing = entry({
		status: 404,
		type: HTML,
		policy: PAGE_POLICY,
		body: renderDocument({
			page: null,
			title: "No such page",
			lead: "This address is not a page of the Mainworthy documentation.",
			headings: [],
			version,
			html: `<h1>No such page</h1><p>This address is not a page of the documentation. The pages are listed on the left, and the search finds a word on any of them.</p><p><a href="${DOCS_ROOT}">Go to the first page</a></p>`,
		}),
	});
	return { articles, search, entries, missing };
}

const redirect = (to: string): Response => new Response(null, { status: 308, headers: { location: to } });

function reply(req: Request, found: Entry): Response {
	const headers: Record<string, string> = {
		"content-type": found.type,
		"content-security-policy": found.policy,
		"x-content-type-options": "nosniff",
		"referrer-policy": "same-origin",
		// Kept by the browser and asked about each time: a page read twice costs one short request the second time.
		"cache-control": "no-cache",
		etag: found.etag,
		vary: "accept-encoding",
	};
	if (found.status === 200 && req.headers.get("if-none-match") === found.etag)
		return new Response(null, { status: 304, headers });
	const zipped = found.gzip && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "") ? found.gzip : null;
	if (zipped) headers["content-encoding"] = "gzip";
	return new Response(req.method === "HEAD" ? null : (zipped ?? found.body), { status: found.status, headers });
}

/**
 * The handler for `/docs` and `/docs/*`. The site is rendered on the first request and kept: a server that nobody
 * asks for its documentation never builds it.
 */
export function docsHandler(version: string): (req: Request) => Promise<Response> {
	let site: Promise<Site> | null = null;
	return async (req) => {
		if (req.method !== "GET" && req.method !== "HEAD")
			return new Response(`${escapeHtml(req.method)} is not allowed here`, {
				status: 405,
				headers: { allow: "GET, HEAD" },
			});
		site ??= buildSite(version);
		const built = await site;
		let path: string;
		try {
			path = decodeURI(new URL(req.url).pathname);
		} catch {
			// Not an address at all (a broken percent escape).
			return reply(req, built.missing);
		}
		const found = built.entries.get(path);
		if (found) return reply(req, found);
		// The addresses a reader may reasonably type or copy: a trailing slash, the first page by its name, and a
		// page by its file name (a link copied from the Markdown).
		const slug = path
			.slice(DOCS_ROOT.length + 1)
			.replace(/\/$/, "")
			.replace(/\.md$/, "");
		if (slug === "" || isDocSlug(slug)) return redirect(docUrl(slug === "" ? "index" : slug));
		return reply(req, built.missing);
	};
}

/**
 * The routes to hand to `serve` as `open`. `/privacy` is the address the App Store listing gives for the privacy
 * policy, which is a page of the documentation.
 */
export function docsRoutes(version: string): Record<string, (req: Request) => Response | Promise<Response>> {
	const handler = docsHandler(version);
	return { [DOCS_ROOT]: handler, [`${DOCS_ROOT}/*`]: handler, "/privacy": () => redirect(docUrl("privacy")) };
}
