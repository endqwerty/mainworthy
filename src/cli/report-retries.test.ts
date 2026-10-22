import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { withInstance } from "./test-support.ts";

test("native retry reports upload through the executable and retain recovery evidence on CLI reads", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const root = await realpath(directory);
		for (const [index, format] of ["jest", "vitest", "pytest"].entries()) {
			const fixture = new URL(`../../test/fixtures/reports/${format}-retries.json`, import.meta.url);
			const file = join(directory, `${format}.json`);
			await Bun.write(file, (await Bun.file(fixture).text()).replaceAll("/workspace", root));
			const uploaded = await (index === 0 ? cli : run)([
				"report",
				file,
				"--commit",
				`aabb073${index}`,
				"--job",
				format,
				"--json",
			]);
			expect({ code: uploaded.code, stderr: format === "jest" ? uploaded.stderr : "" }).toEqual({
				code: 0,
				stderr: "",
			});
			expect(JSON.parse(uploaded.stdout).counts).toEqual({ total: 4, pass: 2, fail: 1, skip: 1, error: 0, blocked: 0 });
			if (format === "jest") expect(uploaded.stderr).toBe("");
			else expect(uploaded.stderr).toContain("retry count");
			const read = await run(["get", `T-${index * 4 + 1}`, "--json"]);
			expect(read.code).toBe(0);
			const page = JSON.parse(read.stdout)[0];
			expect(page.flips).toBe(1);
			expect(page.last[0].outcome).toBe("pass");
			expect(page.last[0].tries).toHaveLength(format === "jest" ? 2 : 1);
		}
	});
});
