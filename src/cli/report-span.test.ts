import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { withInstance } from "./test-support.ts";

// `mainworthy report` sends the span its files name (issue #722): joined when every file names one, none otherwise.

const fixture = (name: string) => new URL(`../../test/fixtures/reports/${name}`, import.meta.url);

test("a report of several files sends their joined span, and none when one file has none", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const root = await realpath(directory);
		const playwright = join(directory, "playwright.json");
		const jest = join(directory, "jest.json");
		const untimed = join(directory, "untimed.xml");
		await Bun.write(playwright, Bun.file(fixture("real-playwright.json")));
		await Bun.write(jest, (await Bun.file(fixture("real-jest.json")).text()).replaceAll("/home/robin/project", root));
		await Bun.write(untimed, '<testsuite name="unit"><testcase name="adds" classname="cart"/></testsuite>');

		const timed = await cli(["report", playwright, jest, "--commit", "aabb0722a", "--job", "e2e", "--json"]);
		expect(timed.code).toBe(0);
		const read = await run(["find", "--json", JSON.stringify({ in: "results", commit: "aabb0722a" })]);
		// Jest's run started first; Playwright's ended last.
		expect(JSON.parse(read.stdout).reportedSpan).toEqual({
			startedAt: 1792040850012,
			endedAt: Date.parse("2026-10-15T05:07:32.255Z") + 2030,
		});

		const mixed = await run(["report", playwright, untimed, "--commit", "aabb0722b", "--job", "e2e", "--json"]);
		expect(mixed.code).toBe(0);
		const none = await run(["find", "--json", JSON.stringify({ in: "results", commit: "aabb0722b" })]);
		expect(JSON.parse(none.stdout).reportedSpan).toBeNull();
	});
});
