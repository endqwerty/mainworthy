import { expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyAudit } from "../core/audit.ts";
import { withInstance } from "./test-support.ts";

test("audit exports through the real CLI and verifies offline without reading credentials", async () => {
	await withInstance(async ({ cli, run, client, directory }) => {
		await client.call("propose", { edits: [{ op: "create", outline: "Audit from the CLI" }] });
		const file = join(directory, "audit.ndjson");
		const exported = await cli(["audit", "export", "--out", file]);
		expect(exported.code).toBe(0);
		expect(exported.stderr).toBe("");
		expect(exported.stdout).toContain("audit records");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const original = await Bun.file(file).text();
		expect(verifyAudit(original)).toMatchObject({ project: "scratch", unavailableDecisionEvidence: 0 });
		const checked = await run(["audit", "verify", file, "--json"], {
			env: { MAINWORTHY_URL: "invalid", MAINWORTHY_TOKEN_FILE: "/does-not-exist" },
		});
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.stdout)).toMatchObject({ project: "scratch", unavailableDecisionEvidence: 0 });
		const invalidRange = await run(["audit", "export", "--out", file, "--from", "2026-10-15"]);
		expect(invalidRange.code).toBe(4);
		expect(invalidRange.stderr).toContain("ISO timestamps with a timezone");
		expect(await Bun.file(file).text()).toBe(original);
		await writeFile(file, original.replace("Audit from the CLI", "Changed in the CLI"));
		const rejected = await run(["audit", "verify", file]);
		expect(rejected.code).toBe(4);
		expect(rejected.stderr).toContain("checksum mismatch");
	});
});
