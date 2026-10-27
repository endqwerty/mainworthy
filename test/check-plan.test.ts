import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { opensBrowser } from "../scripts/browser-tests.ts";
import { needsBrowserFixture, PERFORMANCE, parseCheckArgs, phaseFiles, testArgs } from "../scripts/check-plan.ts";
import { matrix } from "../scripts/ci-scope.ts";

const browserFiles = [...new Glob("{src,test}/**/*.test.{ts,tsx}").scanSync(".")].filter(opensBrowser);

const selected = (argv: string[]) => {
	const options = parseCheckArgs(argv);
	return options.phases.flatMap((phase) => phaseFiles(phase, options.shard, options.chosen, options.browser) ?? []);
};

test("the default check omits Chromium users but keeps server and process tests", () => {
	const files = selected([]);
	expect(files).toContain("test/e2e/ports.test.ts");
	expect(files).toContain("test/e2e/lifetime.test.ts");
	expect(files).toContain("test/ci-scope.test.ts");
	expect(files).not.toContain("test/check.test.ts");
	expect(files).not.toContain("test/e2e/phone.test.ts");
	expect(files).toEqual((phaseFiles("parallel") ?? []).filter((file) => !opensBrowser(file)));
	expect(needsBrowserFixture(["parallel"], undefined, files)).toBe(false);
	expect(needsBrowserFixture(["parallel"], "1/14", undefined, false)).toBe(false);
	const args = testArgs("parallel", { timings: "t.json", browser: false });
	for (const file of browserFiles) expect(args).toContain(`--path-ignore-patterns=${file}`);
});

test("--browser restores every functional file and explicit browser files still run", () => {
	expect(selected(["--browser"])).toEqual(phaseFiles("parallel") ?? []);
	expect(selected(["test", "--browser"])).toEqual(phaseFiles("parallel") ?? []);
	expect(selected(["test", "--only=parallel", "test/e2e/phone.test.ts"])).toEqual(["test/e2e/phone.test.ts"]);
	expect(selected(["test", "--only=parallel", "test/check.test.ts"])).toEqual(["test/check.test.ts"]);
	for (const file of browserFiles.filter((file) => !PERFORMANCE.includes(file)))
		expect(testArgs("parallel", { timings: "t.json", browser: true })).not.toContain(`--path-ignore-patterns=${file}`);
	expect(selected(["test", "--update-timings"])).toContain("test/check.test.ts");
	expect(selected(["test", "--only=performance"])).toEqual(PERFORMANCE);
});

test("CI's full matrix opts into browsers and named plans preserve them", () => {
	const workflow = readFileSync(".github/workflows/check.yml", "utf8");
	expect(workflow).toContain(`bun scripts/check.ts test $\{{ matrix.phase }}`);
	const full = matrix("all");
	const covered = new Set<string>();
	for (const entry of full) {
		const options = parseCheckArgs(["test", ...entry.phase.split(" ")]);
		expect(options.browser).toBe(true);
		for (const phase of options.phases) {
			const args = testArgs(phase, { ...options, files: options.chosen, timings: "t.json" });
			for (const file of browserFiles.filter((file) => PERFORMANCE.includes(file) === (phase === "performance")))
				expect(args).not.toContain(`--path-ignore-patterns=${file}`);
			for (const file of phaseFiles(phase, undefined, options.chosen, options.browser) ?? []) covered.add(file);
		}
	}
	for (const file of browserFiles) expect(covered.has(file), file).toBe(true);
	for (const entry of matrix(browserFiles)) {
		const options = parseCheckArgs(["test", ...entry.phase.split(" "), ...entry.files.split(" ")]);
		for (const file of options.chosen ?? [])
			expect(selected(["test", ...entry.phase.split(" "), file])).toEqual([file]);
	}
});

test("a server-only runner skips browser startup and explains the omitted coverage", async () => {
	const child = Bun.spawn([process.execPath, "scripts/check.ts", "test", "--only=parallel", "src/core/text.test.ts"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exit, out + err).toBe(0);
	expect(out).toContain("browser tests did not run");
	expect(out).toContain("bun run check --browser");
	expect(out).not.toContain("browser fixture");
	expect(out).not.toContain("shared Chromium slots");
});
