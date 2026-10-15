// Mainworthy's licence, and the licences of what it ships that others wrote (`scripts/licences.ts`). A dependency
// added, removed or upgraded changes what the build bundles, and the notices must say so before it ships; a
// licence nobody has accepted fails here with the package's name.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bundledPackages,
	bunMismatch,
	ENTRYPOINTS,
	missingTexts,
	NOTICES,
	notices,
	readVendored,
	unapproved,
} from "../scripts/licences.ts";
import { importAudit } from "../scripts/licences-import-bun.ts";
import { DOC_PAGES, DOCS_ROOT, docUrl, LICENCE_FILES, licenceFileUrl } from "../src/core/docs.ts";
import { VERSION } from "../src/server/start.ts";
import { docsHandler } from "../src/surfaces/docs/site.ts";

const read = (path: string): string => readFileSync(path, "utf8");
const HOLDER = "Copyright 2026 Daniel Yang";

describe("Mainworthy's licence", () => {
	test("LICENSE is the Apache License 2.0, word for word as the Apache Software Foundation publishes it", () => {
		// The hash of https://www.apache.org/licenses/LICENSE-2.0.txt. GitHub and package tools recognise the
		// licence by this text; an edit, even of the appendix, makes it a different licence.
		const hash = createHash("sha256").update(readFileSync("LICENSE")).digest("hex");
		expect(hash).toBe("cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
	});

	test("the owner's name is written only in the copyright line and its checks", () => {
		// AGENTS.md: the copyright line is the one exception to the rule that the owner's name is not written in the
		// repository. A sentence that names them elsewhere is the verifier's finding of 2026-10-14.
		const name = HOLDER.replace("Copyright 2026 ", "");
		// Every file of the tree, not only those git tracks: a checkout and an export are read alike. What others
		// wrote (installed packages, licences/) can name anyone.
		// `dist` is the build's output, which carries NOTICE inside the executable (the verifier's finding of 2026-10-14).
		const skip = new Set([".git", "node_modules", "licences", ".mainworthy", "test-results", "dist"]);
		const files = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const path = dir === "." ? entry.name : join(dir, entry.name);
				if (entry.isDirectory()) return skip.has(entry.name) ? [] : files(path);
				return entry.isFile() ? [path] : [];
			});
		const naming = files(".").filter((file) => read(file).includes(name));
		expect(naming.sort()).toEqual([
			"NOTICE",
			"ios/App/Info.plist",
			"ios/UITests/QueueUITests.swift",
			"test/licences.test.ts",
		]);
	});

	test("the package, the NOTICE file and the iPhone app name the same licence and copyright holder", () => {
		expect(JSON.parse(read("package.json")).license).toBe("Apache-2.0");
		expect(read("NOTICE").split("\n").slice(0, 2)).toEqual(["Mainworthy", HOLDER]);
		expect(read("ios/App/Info.plist")).toContain(`<key>NSHumanReadableCopyright</key>\n\t<string>${HOLDER}</string>`);
		expect(read("ios/UITests/QueueUITests.swift")).toContain(`"${HOLDER}"`);
	});
});

describe("the third-party notices", () => {
	test("THIRD-PARTY-NOTICES.md is what the packages the build bundles and licences/ make of it", async () => {
		expect(await notices(), "run bun scripts/licences.ts").toBe(read(NOTICES));
	});

	test("every component ships under a licence that has been accepted", async () => {
		expect(await unapproved(), `accept each in LICENCES (scripts/licences.ts) or drop it`).toEqual([]);
	});

	test("a bundled npm package whose archive omits its licence keeps the saved upstream text", async () => {
		const saxes = (await bundledPackages()).find((pkg) => pkg.name === "saxes");
		expect(saxes?.version).toBe("6.0.0");
		expect(saxes?.dir).toEndWith("licences/npm/saxes@6.0.0");
		expect(saxes?.texts).toEqual(["LICENSE"]);
		expect(createHash("sha256").update(read("licences/npm/saxes@6.0.0/LICENSE")).digest("hex")).toBe(
			"0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e",
		);
	});

	test("every licence text the notices name is in licences/", () => {
		expect(missingTexts()).toEqual([]);
	});

	test("the notices are read from the entry points the build compiles", async () => {
		const { build, prebuild } = JSON.parse(read("package.json")).scripts;
		// The Codex review of #226: a local build with another Bun carries a runtime the notices do not describe.
		// `bun run build` runs `prebuild` first; `build` stays the one command the Dockerfile runs too.
		expect(prebuild).toBe("bun scripts/licences.ts --check-bun");
		expect(bunMismatch(readVendored().bun)).toBeNull();
		expect(bunMismatch("1.4.2")).toContain("lists the libraries of Bun 1.4.3");
		const docker = read("Dockerfile");
		for (const entry of ENTRYPOINTS) {
			expect(build).toContain(entry);
			expect(docker).toContain(entry);
		}
		// The bundle reaches React and the agent SDK; a list without them was read from the wrong place.
		const names = (await bundledPackages()).map((p) => p.name);
		expect(names).toContain("react-dom");
		expect(names).toContain("@modelcontextprotocol/server");
		expect(names).toContain("@modelcontextprotocol/core");
	});

	test("the Bun the notices list is the Bun the image and CI build with", () => {
		const bun = readVendored()
			.groups.flatMap((g) => g.components)
			.find((c) => c.name === "Bun");
		expect(bun, "licences/components.json lists Bun").toBeDefined();
		expect(read("Dockerfile")).toContain(`FROM oven/bun:${bun?.version} AS build`);
		const ci = [...read(".github/workflows/check.yml").matchAll(/bun-version: (\S+)/g)].map((m) => m[1]);
		expect(ci.length).toBeGreaterThan(0);
		expect(new Set(ci)).toEqual(new Set([bun?.version]));
	});

	test("every diagram page an instance serves carries Archify's licence, word for word", async () => {
		// Each page embeds Archify's viewer, which is MIT: its notice has to travel with every copy a browser gets.
		// The font's licence is in the page already, as archify writes it.
		const handler = docsHandler(VERSION);
		const notice = read("licences/archify/LICENSE");
		const names = readdirSync("docs/diagrams").filter((file) => file.endsWith(".html"));
		expect(names.length).toBeGreaterThan(0);
		for (const file of names) {
			const html = await (await handler(new Request(`http://localhost${DOCS_ROOT}/diagrams/${file}`))).text();
			expect(html, file).toContain(notice);
			expect(html, file).toContain("SIL OPEN FONT LICENSE Version 1.1");
		}
	});

	test("every page of the docs links the licence page at its foot", async () => {
		const handler = docsHandler(VERSION);
		for (const page of DOC_PAGES) {
			const html = await (await handler(new Request(`http://localhost${docUrl(page.slug)}`))).text();
			const foot = /<footer class="foot">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
			expect(foot, page.slug).toContain(`<a href="${docUrl("licence")}">Licence</a>`);
		}
	});

	test("an instance serves each licence file as it is in the repository", async () => {
		const handler = docsHandler(VERSION);
		for (const name of LICENCE_FILES) {
			const reply = await handler(new Request(`http://localhost${licenceFileUrl(name)}`));
			expect(reply.status, name).toBe(200);
			expect(reply.headers.get("content-type")).toBe("text/plain; charset=utf-8");
			expect(await reply.text()).toBe(read(name));
		}
	});
});

describe("bringing in an audit of Bun", () => {
	test("a source file's own notice is kept beside its project's licence file, and only identical bytes are one text", () => {
		// The verifier's finding of 2026-10-14: WTF's FastMalloc.cpp carries a BSD notice of its own beside
		// JavaScriptCore's LGPL, and TinyCC's libtcc1.c the exception that applies to it; both were dropped.
		const dir = mkdtempSync(join(tmpdir(), "licences-"));
		try {
			const file = (path: string, text: string): void => {
				mkdirSync(join(dir, "audit", "texts", path, ".."), { recursive: true });
				writeFileSync(join(dir, "audit", "texts", path), text);
			};
			const mit = "MIT License\n\nCopyright (c) 2020 A\n";
			file("wtf/COPYING.LIB", "GNU LIBRARY GENERAL PUBLIC LICENSE\n");
			file("wtf/FastMalloc.cpp", "/*\n * Copyright (c) 2005 Google Inc.\n * Redistribution and use ...\n */\nint x;\n");
			file("a/LICENSE", mit);
			file("b/LICENSE", mit.replace("\n\n", "\n \n"));
			const component = (name: string, texts: string[]) => ({
				name,
				kind: "c-library",
				version: "1",
				commit: null,
				source: "https://example.com/",
				license: "MIT",
				relyOn: "MIT",
				linked: "yes",
				why: "linked",
				texts,
			});
			writeFileSync(
				join(dir, "audit", "manifest.json"),
				JSON.stringify([
					component("WTF", ["wtf/COPYING.LIB", "wtf/FastMalloc.cpp"]),
					component("A", ["a/LICENSE"]),
					component("B", ["b/LICENSE"]),
				]),
			);
			importAudit(join(dir, "audit"), "9.9.9", dir);
			const { groups } = JSON.parse(read(join(dir, "bun-9.9.9", "components.json")));
			const texts = Object.fromEntries(
				groups.flatMap((g: { components: { name: string; texts: string[] }[] }) =>
					g.components.map((c) => [c.name, c.texts]),
				),
			);
			expect(texts.WTF).toEqual(["bun-9.9.9/texts/wtf/COPYING.LIB", "bun-9.9.9/texts/wtf/FastMalloc.cpp.licence.txt"]);
			expect(read(join(dir, texts.WTF[1]))).toContain("Copyright (c) 2005 Google Inc.");
			// The same words with other whitespace are another file as published, and stay one.
			expect(texts.B).toEqual(["bun-9.9.9/texts/b/LICENSE"]);
			expect(read(join(dir, texts.B[0]))).toBe(mit.replace("\n\n", "\n \n"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
