// The user documentation (`docs/guide`, served at `/docs`) is kept true by these tests. A change that adds an
// operation, a command, a variable, a preset or a screen and says nothing of it in the docs fails here, with the
// name of what is missing; so does a table that no longer matches the code, a link that leads nowhere and a
// diagram that was not built again after its source changed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import { candidatePath, currentStamp, diagramNames, STAMP, Stamp } from "../scripts/diagrams.ts";
import { applyBlocks, blocksIn, generatedBlocks } from "../scripts/gen-docs.ts";
import { ADAPTER_COMMANDS } from "../src/cli/dispatch.ts";
import { DOC_PAGES, DOCS_ROOT, docUrl, isDocSlug, SCREEN_DOCS } from "../src/core/docs.ts";
import { Capability, KINDS } from "../src/core/kinds.ts";
import { PRESET_NAMES } from "../src/core/presets.ts";
import { Verdict } from "../src/core/runs.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { HTTP_STATUS } from "../src/server/kernel/errors.ts";
import { OP_LIST } from "../src/server/ops/index.ts";
import { type Instance, start, VERSION } from "../src/server/start.ts";
import { DIAGRAMS, PAGES, SCREENSHOTS } from "../src/surfaces/docs/content.ts";
import { renderArticle } from "../src/surfaces/docs/render.ts";
import { docsRoutes, withoutRepositoryAddress } from "../src/surfaces/docs/site.ts";

const GUIDE = "docs/guide";
const files = readdirSync(GUIDE)
	.filter((file) => file.endsWith(".md"))
	.sort();
const read = (slug: string): string => readFileSync(join(GUIDE, `${slug}.md`), "utf8");
const articles = new Map(DOC_PAGES.map((page) => [page.slug, renderArticle(PAGES[page.slug])] as const));
const everything = DOC_PAGES.map((page) => PAGES[page.slug]).join("\n");

describe("the pages", () => {
	test("every page in the table of contents is a file, and every file is in the table of contents", () => {
		expect(files).toEqual(DOC_PAGES.map((page) => `${page.slug}.md`).sort());
		// What the server carries is the file, not a copy that could be older.
		for (const page of DOC_PAGES) expect(PAGES[page.slug]).toBe(read(page.slug));
	});

	test("a page has the title the table of contents gives it, and a first paragraph that says what it is for", () => {
		for (const page of DOC_PAGES) {
			const article = articles.get(page.slug);
			expect(article?.title, `${page.slug}.md starts with "# ${page.title}"`).toBe(page.title);
			expect(article?.lead.length, `${page.slug}.md has a lead paragraph`).toBeGreaterThan(40);
		}
	});

	test("a page refers only to what the site serves: other pages, diagrams, screenshots and https addresses", () => {
		const problems = DOC_PAGES.flatMap((page) =>
			(articles.get(page.slug)?.problems ?? []).map((problem) => `${page.slug}.md: ${problem}`),
		);
		expect(problems).toEqual([]);
	});

	test("a link to a heading of another page finds that heading", () => {
		const ids = new Map(
			DOC_PAGES.map((page) => [docUrl(page.slug), new Set(articles.get(page.slug)?.headings.map((h) => h.id))]),
		);
		const broken: string[] = [];
		for (const page of DOC_PAGES) {
			for (const match of (articles.get(page.slug)?.html ?? "").matchAll(/<a href="(\/docs[^"#]*)#([^"]+)"/g)) {
				if (!ids.get(match[1] ?? "")?.has(match[2] ?? ""))
					broken.push(`${page.slug}.md links to ${match[1]}#${match[2]}`);
			}
			for (const match of (articles.get(page.slug)?.html ?? "").matchAll(/<a href="#([^"]+)"/g)) {
				if (!ids.get(docUrl(page.slug))?.has(match[1] ?? "")) broken.push(`${page.slug}.md links to #${match[1]}`);
			}
		}
		expect(broken).toEqual([]);
	});

	test("every diagram and screenshot a page shows is carried by the server, and nothing is carried unshown", () => {
		const shown = (pick: "diagrams" | "screenshots"): string[] =>
			[...new Set(DOC_PAGES.flatMap((page) => articles.get(page.slug)?.[pick] ?? []))].sort();
		expect(shown("diagrams")).toEqual(Object.keys(DIAGRAMS).sort());
		expect(shown("screenshots")).toEqual(Object.keys(SCREENSHOTS).sort());
	});

	test("the tables read from the code say what the code says now", () => {
		const blocks = generatedBlocks();
		const used = new Set<string>();
		for (const page of DOC_PAGES) {
			const committed = read(page.slug);
			for (const name of blocksIn(committed)) used.add(name);
			expect(applyBlocks(committed, blocks), `${page.slug}.md: run bun scripts/gen-docs.ts`).toBe(committed);
			// A marker that is opened and not closed would leave its table to go stale unnoticed.
			expect(committed.match(/<!-- generated:/g)?.length ?? 0).toBe(blocksIn(committed).length);
		}
		expect([...used].sort()).toEqual(Object.keys(blocks).sort());
	});

	test("nothing in a page or a diagram names a path on the machine it was written on", () => {
		const local = /\/(Users|Volumes|home)\/[A-Za-z]/;
		const offenders = [
			...DOC_PAGES.filter((page) => local.test(PAGES[page.slug])).map((page) => `${page.slug}.md`),
			...Object.entries(DIAGRAMS)
				.filter(([, html]) => local.test(html))
				.map(([name]) => `${name}.html`),
		];
		expect(offenders).toEqual([]);
	});
});

describe("what the docs must name", () => {
	// Each list is read from the code. A name the docs do not say is a feature a reader cannot find.
	const missing = (names: readonly string[], text = everything): string[] =>
		names.filter(
			(name) =>
				!new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`).test(text),
		);

	test("every operation and every command", () => {
		expect(missing(OP_LIST.map((op) => `mainworthy ${op.name}`))).toEqual([]);
		expect(missing([...ADAPTER_COMMANDS.keys(), "serve", "help"].map((name) => `mainworthy ${name}`))).toEqual([]);
	});

	test("every variable a person can set", () => {
		// Every MAINWORTHY_ name the product reads, from the source. The two the tests of the agent endpoint read
		// are not the product's.
		const names = new Set<string>();
		for (const file of new Glob("src/**/*.{ts,tsx}").scanSync(".")) {
			if (file.endsWith(".test.ts") || file.endsWith("test-support.ts")) continue;
			for (const match of readFileSync(file, "utf8").matchAll(/\bMAINWORTHY_[A-Z]+(?:_[A-Z]+)*\b/g))
				names.add(match[0]);
		}
		expect(names.size).toBeGreaterThan(15);
		expect(missing([...names].sort())).toEqual([]);
	});

	test("every preset, capability, kind of question, verdict and error code", () => {
		expect(missing(PRESET_NAMES.map((name) => `\`${name}\``))).toEqual([]);
		expect(missing(Capability.options.map((name) => `\`${name}\``))).toEqual([]);
		expect(missing(KINDS.map((name) => `\`${name}\``))).toEqual([]);
		expect(missing(Verdict.options.map((name) => `\`${name}\``))).toEqual([]);
		expect(missing(Object.keys(HTTP_STATUS).map((name) => `\`${name}\``))).toEqual([]);
	});

	test("every screen of the web UI has a page, and the page says how to open the screen", () => {
		// The screens are the router's (`src/web/lib/router.ts`); the app refuses to compile with one that is not in
		// SCREEN_DOCS. A page that explains a screen names it.
		const names: Record<keyof typeof SCREEN_DOCS, string> = {
			suite: "suite",
			case: "case",
			queue: "queue",
			runs: "run",
			changes: "Changes",
			settings: "Settings",
		};
		for (const [screen, slug] of Object.entries(SCREEN_DOCS)) {
			expect(isDocSlug(slug)).toBe(true);
			expect(PAGES[slug].toLowerCase(), `${slug}.md explains the ${screen} screen`).toContain(
				names[screen as keyof typeof SCREEN_DOCS].toLowerCase(),
			);
		}
	});
});

describe("the diagrams", () => {
	test("every diagram has its source, and its page was built from the source as it is now", () => {
		const pages = readdirSync("docs/diagrams")
			.filter((file) => file.endsWith(".html"))
			.map((file) => file.slice(0, -".html".length))
			.sort();
		expect(pages).toEqual(diagramNames());
		const stamp = Stamp.parse(JSON.parse(readFileSync(STAMP, "utf8")));
		// A candidate edited without `bun scripts/diagrams.ts build`, or a page edited by hand, differs here.
		expect(currentStamp(), "run bun scripts/diagrams.ts build <archify directory> <name>").toEqual(stamp);
	});

	test("only pages and their pictures are beside the sources: no receipt of the tool that built them", () => {
		expect(readdirSync("docs/diagrams").filter((file) => !/\.(html|png)$/.test(file))).toEqual(["src"]);
	});
});

describe("the site", () => {
	let instance: Instance;
	let directory: string;
	const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
		fetch(`${instance.url}${path}`, { headers, redirect: "manual" });

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "mainworthy-docs-"));
		// Server mode, and no token in any request below: the documentation is read without an account.
		instance = start(
			defaultConfig({ MAINWORTHY_DATA: directory, MAINWORTHY_PORT: "0", MAINWORTHY_MODE: "server" }),
			() => ({ ui: null, open: docsRoutes(VERSION) }),
			{ readers: 0 },
		);
	});
	afterAll(async () => {
		await instance.stop();
		await rm(directory, { recursive: true, force: true });
	});

	test("every page is served without a session, as a page that runs no script but the site's own", async () => {
		for (const page of DOC_PAGES) {
			const response = await get(docUrl(page.slug));
			expect(response.status, docUrl(page.slug)).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
			const policy = response.headers.get("content-security-policy") ?? "";
			expect(policy).toContain("default-src 'none'");
			expect(policy).toContain("script-src 'self'");
			expect(policy).not.toContain("unsafe-inline");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("set-cookie")).toBeNull();
			const html = await response.text();
			expect(html).toContain(
				`<title>${page.slug === "index" ? "Mainworthy docs" : `${page.title} · Mainworthy docs`}</title>`,
			);
			expect(html).toContain(`aria-current="page">${page.title}</a>`);
			expect(html).toContain(`Mainworthy ${VERSION}`);
			// Nothing a page writes into itself needs a script or a style of its own.
			expect(html).not.toMatch(/<script(?! src="\/docs\/assets\/site\.js")/);
			expect(html).not.toMatch(/\sstyle="/);
			expect(html).not.toMatch(/\son[a-z]+="/);
		}
	});

	test("the rest of the server still asks who is calling", async () => {
		expect((await get("/api/session")).status).toBe(401);
		const reply = await fetch(`${instance.url}/api/p/scratch/find`, { method: "POST", body: "{}" });
		expect(reply.status).toBe(401);
	});

	test("an address that is not a page says so, and the addresses a reader may type lead to the page", async () => {
		const unknown = await get("/docs/no-such-page");
		expect(unknown.status).toBe(404);
		expect(await unknown.text()).toContain("No such page");
		for (const [from, to] of [
			["/docs/", "/docs"],
			["/docs/index", "/docs"],
			["/docs/policy.md", "/docs/policy"],
			["/docs/policy/", "/docs/policy"],
		]) {
			const response = await get(from ?? "");
			expect(response.status, from).toBe(308);
			expect(response.headers.get("location")).toBe(to ?? "");
		}
		expect((await get("/docs/%E0%A4%A")).status).toBe(404);
		expect((await fetch(`${instance.url}/docs`, { method: "POST" })).status).toBe(405);
	});

	test("a diagram is served as a stranger to the server: it runs its own script and reaches nothing", async () => {
		for (const name of Object.keys(DIAGRAMS)) {
			const response = await get(`${DOCS_ROOT}/diagrams/${name}.html`);
			expect(response.status, name).toBe(200);
			const policy = response.headers.get("content-security-policy") ?? "";
			// Without allow-same-origin the page has an origin of its own: no cookie, no storage, no API call as the reader.
			expect(policy).toContain("sandbox allow-scripts allow-downloads;");
			expect(policy).not.toContain("allow-same-origin");
			expect(policy).toContain("default-src 'none'");
			expect(policy).not.toContain("connect-src");
			const html = await response.text();
			expect(html).toContain("<svg");
			// The page says which files a part was drawn from, and not whose repository they are in.
			const candidate = z
				.object({ meta: z.object({ repository: z.object({ url: z.string() }) }) })
				.parse(JSON.parse(readFileSync(candidatePath(name), "utf8")));
			const address = candidate.meta.repository.url.replace(/\.git$/, "");
			const account = address.split(/[:/]/).slice(-2).join("/");
			expect(account.split("/")).toHaveLength(2);
			expect(html).not.toContain(address);
			expect(html).not.toContain(account);
			expect(html).toContain('"label":"mainworthy"');
			expect(html).toContain('"path":"src/');
		}
	});

	test("a diagram page keeps its files and loses its repository's address, and one that cannot be read is left alone", () => {
		const page = (data: string): string =>
			`<p>before</p><script id="archify-source-evidence-data" type="application/json">${data}</script><p>after</p>`;
		const sent = withoutRepositoryAddress(
			page(
				'{"repository":{"url":"git@example.com:someone/thing","label":"someone/thing","revision":"abc"},"nodes":{"a":[{"path":"src/x.ts"}],"b":"1 \\u003c 2"}}',
			),
		);
		expect(sent).not.toContain("someone");
		expect(sent).toContain('"repository":{"url":"mainworthy","label":"mainworthy","revision":"abc"}');
		expect(sent).toContain('"nodes":{"a":[{"path":"src/x.ts"}],"b":"1 \\u003c 2"}');
		expect(sent.startsWith("<p>before</p>") && sent.endsWith("</script><p>after</p>")).toBe(true);
		// Nothing to read, or nothing it knows: the page is what it was, and the site still answers.
		for (const data of ["{not json", "[]", '{"nodes":{}}'])
			expect(withoutRepositoryAddress(page(data))).toBe(page(data));
		expect(withoutRepositoryAddress("<svg></svg>")).toBe("<svg></svg>");
	});

	test("what a page shows is there: the style sheet, the script, the icon and each screenshot", async () => {
		for (const [path, type] of [
			["/docs/assets/site.css", "text/css; charset=utf-8"],
			["/docs/assets/site.js", "text/javascript; charset=utf-8"],
			["/docs/assets/icon.svg", "image/svg+xml"],
			...Object.keys(SCREENSHOTS).map((name) => [`/docs/screenshots/${name}.png`, "image/png"]),
		]) {
			const response = await get(path ?? "");
			expect(response.status, path).toBe(200);
			expect(response.headers.get("content-type")).toBe(type ?? "");
			expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(200);
		}
		// Every page asks for these and for nothing else of the server's.
		const html = await (await get("/docs")).text();
		const asked = [...html.matchAll(/(?:src|href)="(\/docs\/assets\/[^"]+)"/g)].map((match) => match[1]).sort();
		expect(asked).toEqual(["/docs/assets/icon.svg", "/docs/assets/site.css", "/docs/assets/site.js"]);
	});

	test("the search knows every page, and finds a word by the page that explains it", async () => {
		const entries = (await (await get("/docs/search.json")).json()) as { url: string; page: string; text: string }[];
		expect(new Set(entries.map((entry) => entry.url.split("#")[0]))).toEqual(
			new Set(DOC_PAGES.map((page) => docUrl(page.slug))),
		);
		expect(entries.filter((entry) => /flaky/i.test(entry.text)).map((entry) => entry.page)).toContain(
			"Decide in the queue",
		);
	});

	test("a page read twice is sent once, and is sent compressed to a browser that asks", async () => {
		const first = await get("/docs/concepts");
		const etag = first.headers.get("etag") ?? "";
		expect(etag.length).toBeGreaterThan(4);
		expect(first.headers.get("cache-control")).toBe("no-cache");
		const again = await get("/docs/concepts", { "if-none-match": etag });
		expect(again.status).toBe(304);
		expect((await again.text()).length).toBe(0);
		const plain = await get("/docs/diagrams/red-build.html", { "accept-encoding": "identity" });
		const zipped = await fetch(`${instance.url}/docs/diagrams/red-build.html`, {
			headers: { "accept-encoding": "gzip" },
			decompress: false,
		});
		expect(zipped.headers.get("content-encoding")).toBe("gzip");
		const sizes = [(await plain.arrayBuffer()).byteLength, (await zipped.arrayBuffer()).byteLength];
		expect(sizes[1]).toBeLessThan((sizes[0] ?? 0) / 2);
	});
});

describe("the build", () => {
	test("the container image is built with everything the site carries", () => {
		// `content.ts` imports its files from these directories. One that the Dockerfile does not copy, or that
		// `.dockerignore` keeps out, is a build that fails on the server and nowhere before it.
		const imported = new Set(
			[
				...readFileSync("src/surfaces/docs/content.ts", "utf8").matchAll(
					/from "\.\.\/\.\.\/\.\.\/(docs\/[a-z/]+)\/[^/"]+"/g,
				),
			].map((match) => match[1] ?? ""),
		);
		expect([...imported].sort()).toEqual(["docs/diagrams", "docs/guide", "docs/ui/screenshots"]);
		const dockerfile = readFileSync("Dockerfile", "utf8");
		const ignored = readFileSync(".dockerignore", "utf8").split("\n");
		for (const directory of imported) {
			expect(dockerfile, `the Dockerfile copies ${directory}`).toContain(`COPY ${directory} ./${directory}`);
			expect(ignored, `.dockerignore lets ${directory} in`).toContain(`!${directory}`);
		}
	});
});
