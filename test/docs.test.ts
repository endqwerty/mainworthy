// The user documentation (`docs/guide`, served at `/docs`) is kept true by these tests. A change that adds an
// operation, a command, a variable, a preset or a screen and says nothing of it in the docs fails here, with the
// name of what is missing; so does a table that no longer matches the code, a link that leads nowhere and a
// diagram that was not built again after its source changed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import { budget } from "../scripts/budget.ts";
import { assemble, fragments } from "../scripts/changelog.ts";
import { decisions } from "../scripts/decisions.ts";
import {
	candidatePath,
	currentStamp,
	diagramNames,
	pictureCommand,
	REPOSITORY,
	SETS,
	Stamp,
	stampPath,
} from "../scripts/diagrams.ts";
import { applyBlocks, blocksIn, generatedBlocks } from "../scripts/gen-docs.ts";
import { type Instance, start, VERSION } from "../src/app/start.ts";
import { ADAPTER_COMMANDS } from "../src/cli/dispatch.ts";
import { HTTP_STATUS } from "../src/core/api.ts";
import { DOC_PAGES, DOCS_ROOT, docUrl, isDocSlug, SCREEN_DOCS } from "../src/core/docs.ts";
import { Capability, KINDS } from "../src/core/kinds.ts";
import { PRESET_NAMES } from "../src/core/presets.ts";
import { Verdict } from "../src/core/runs.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { OP_LIST } from "../src/server/ops/index.ts";
import { DIAGRAMS, PAGES, SCREENSHOTS } from "../src/surfaces/docs/content.ts";
import { renderArticle } from "../src/surfaces/docs/render.ts";
import { docsRoutes, SKILL_URL, withoutRepositoryAddress } from "../src/surfaces/docs/site.ts";

const GUIDE = "docs/guide";
const files = readdirSync(GUIDE)
	.filter((file) => file.endsWith(".md"))
	.sort();
const read = (slug: string): string => readFileSync(join(GUIDE, `${slug}.md`), "utf8");
const articles = new Map(DOC_PAGES.map((page) => [page.slug, renderArticle(PAGES[page.slug])] as const));
const everything = DOC_PAGES.map((page) => PAGES[page.slug]).join("\n");

describe("the contributor records", () => {
	test("decision records accept historical numbers and dated ids with required metadata", () => {
		expect(() => decisions()).not.toThrow();
	});

	test(".changes/ fragments validate and each appears once in the assembled changelog", () => {
		const entries = fragments();
		const assembled = assemble(readFileSync("CHANGELOG.md", "utf8"), entries);
		for (const entry of entries) expect(assembled.split(`<!-- change:${entry.id} -->`)).toHaveLength(2);
	});
});

describe("the pages", () => {
	test("step choices name inline instructions and fragment pins, including the forbidden inline use field", () => {
		const api = generatedBlocks().operations ?? "";
		expect(api).toContain("`edits[][create].body.steps[][inline].action`");
		expect(api).toContain("`edits[][create].body.steps[][fragment].use.fragment`");
		expect(api).toContain("`edits[][create].body.steps[][inline].use` | `never`");
	});

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
		const architecture = readFileSync("docs/architecture.md", "utf8");
		const table = architecture.split("| | Operations |\n")[1]?.split("\n\n")[0] ?? "";
		expect([...table.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort()).toEqual(
			OP_LIST.map((op) => op.name).sort(),
		);
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
			tests: "Tests",
			reports: "Reports",
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
		for (const set of SETS) {
			const pages = readdirSync(set.pages)
				.filter((file) => file.endsWith(".html"))
				.map((file) => file.slice(0, -".html".length))
				.sort();
			expect(pages, set.pages).toEqual(diagramNames(set));
			const stamp = Stamp.parse(JSON.parse(readFileSync(stampPath(set), "utf8")));
			// A candidate edited without `bun scripts/diagrams.ts build`, or a page edited by hand, differs here.
			expect(currentStamp(set), "run bun scripts/diagrams.ts build <archify directory> <name>").toEqual(stamp);
		}
	});

	test("only pages and their pictures are beside the sources: no receipt of the tool that built them", () => {
		expect(readdirSync("docs/diagrams").filter((file) => !/\.(html|png)$/.test(file))).toEqual(["src"]);
		// The repository's diagrams keep each candidate beside its page, and a picture of a page is named for it.
		const names = diagramNames(REPOSITORY);
		const strays = readdirSync(REPOSITORY.pages).filter((file) => {
			if (file === "built.json") return false;
			const match = /^([a-z0-9-]+)\.(html|json|png)$/.exec(file);
			return !match || !names.includes(match[1] ?? "");
		});
		expect(strays).toEqual([]);
	});

	test("every repository diagram has its picture, which a page on GitHub shows", () => {
		const missing = diagramNames(REPOSITORY).filter((name) => !existsSync(join(REPOSITORY.pages, `${name}.png`)));
		expect(missing).toEqual([]);
	});

	test("drawing a picture records nothing: a stale page stays stale, and a name that has no picture is refused", async () => {
		const stamps = SETS.map((set) => readFileSync(stampPath(set), "utf8"));
		const run = Bun.spawnSync(["bun", "scripts/diagrams.ts", "picture", "not-a-diagram"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr.toString()).toContain("not-a-diagram: no candidate");
		await expect(pictureCommand(["overview"])).rejects.toThrow("overview: only a repository diagram has a picture");
		expect(SETS.map((set) => readFileSync(stampPath(set), "utf8"))).toEqual(stamps);
	});

	test("a diagram the repository keeps names no path on the machine it was built on", () => {
		const local = /\/(Users|Volumes|home)\/[A-Za-z]/;
		const offenders = diagramNames(REPOSITORY)
			.flatMap((name) => [`${name}.html`, `${name}.json`])
			.filter((file) => local.test(readFileSync(join(REPOSITORY.pages, file), "utf8")));
		expect(offenders).toEqual([]);
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
			// The address the App Store listing gives for the privacy policy.
			["/privacy", "/docs/privacy"],
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

	test("the agent skill is served, without a session, as one archive that holds exactly the directory skill/mainworthy", async () => {
		const response = await get(SKILL_URL);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/gzip");
		// Already compressed: the server does not compress it again.
		expect(response.headers.get("content-encoding")).toBeNull();
		const served = await new Bun.Archive(await response.bytes()).files();
		const tree = new Map<string, string>();
		for (const path of new Glob("**/*").scanSync({ cwd: "skill", onlyFiles: true }))
			tree.set(path, readFileSync(join("skill", path), "utf8"));
		expect([...served.keys()].sort(), "skill/mainworthy and what the site serves list the same files").toEqual(
			[...tree.keys()].sort(),
		);
		for (const [path, file] of served) expect(await file.text(), path).toBe(tree.get(path) ?? "");
		expect(await get(`${SKILL_URL}x`)).toMatchObject({ status: 404 });
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
		const original = new Uint8Array(await plain.arrayBuffer());
		const compressed = new Uint8Array(await zipped.arrayBuffer());
		// What is sent is the page, compressed; how much smaller it is, is a budget.
		expect(Bun.gunzipSync(compressed)).toEqual(original);
		budget("a gzipped docs diagram", compressed.byteLength, Math.floor(original.byteLength / 2), "bytes");
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
		// The skill the site serves (`content.ts` imports it from `skill/mainworthy`) is copied the same way.
		expect(dockerfile, "the Dockerfile copies skill").toContain("COPY skill ./skill");
		expect(
			ignored.filter((line) => /^!?skill\b/.test(line)),
			".dockerignore keeps skill out",
		).toEqual([]);
		for (const directory of imported) {
			expect(dockerfile, `the Dockerfile copies ${directory}`).toContain(`COPY ${directory} ./${directory}`);
			expect(ignored, `.dockerignore lets ${directory} in`).toContain(`!${directory}`);
		}
	});

	test("the container's build stage has every file the site imports, at the path it imports it from", () => {
		// The test above knows the docs' directories by name; this one reads every import that leaves `src`, so a
		// new kind of file (the licences, 2026-10-14: the verifier found `licences/archify/LICENSE` missing) is
		// caught here and not by a build on the server.
		const files = [
			...readFileSync("src/surfaces/docs/content.ts", "utf8").matchAll(/from "\.\.\/\.\.\/\.\.\/([^"]+)"/g),
		].map((match) => match[1] ?? "");
		expect(files).toContain("licences/archify/LICENSE");
		const stage = readFileSync("Dockerfile", "utf8").split(/^FROM /m)[1] ?? "";
		// `COPY a b ./` puts each where it was; `COPY dir ./dir` too. Only such copies keep the import's path.
		const kept = [...stage.matchAll(/^COPY (?!--)(.+)$/gm)].flatMap((match) => {
			const words = (match[1] ?? "").trim().split(/\s+/);
			const target = words.pop() ?? "";
			return words.filter((source) => target === "./" || target === `./${source}`);
		});
		const ignored = readFileSync(".dockerignore", "utf8").split("\n");
		for (const file of files) {
			expect(
				kept.some((source) => file === source || file.startsWith(`${source}/`)),
				`the build stage copies ${file}`,
			).toBe(true);
			expect(ignored, `.dockerignore keeps out ${file}`).not.toContain(file.split("/")[0]);
		}
	});
});
