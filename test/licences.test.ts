// Mainworthy's licence, and the licences of what it ships that others wrote (`scripts/licences.ts`). A dependency
// added, removed or upgraded changes what the build bundles, and the notices must say so before it ships; a
// licence nobody has accepted fails here with the package's name.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	bundledPackages,
	ENTRYPOINTS,
	missingTexts,
	NOTICES,
	notices,
	readVendored,
	unapproved,
} from "../scripts/licences.ts";
import { LICENCE_FILES, licenceFileUrl } from "../src/core/docs.ts";
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

	test("every licence text the notices name is in licences/", () => {
		expect(missingTexts()).toEqual([]);
	});

	test("the notices are read from the entry points the build compiles", async () => {
		const build = JSON.parse(read("package.json")).scripts.build;
		const docker = read("Dockerfile");
		for (const entry of ENTRYPOINTS) {
			expect(build).toContain(entry);
			expect(docker).toContain(entry);
		}
		// The bundle reaches React and the agent SDK; a list without them was read from the wrong place.
		const names = (await bundledPackages()).map((p) => p.name);
		expect(names).toContain("react-dom");
		expect(names).toContain("@modelcontextprotocol/sdk");
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
