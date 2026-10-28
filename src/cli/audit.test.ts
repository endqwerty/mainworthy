import { expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ciReport } from "../../test/helpers.ts";
import { auditChecksum, verifyAudit } from "../core/audit.ts";
import { canonicalJson } from "../core/hash.ts";
import { withInstance } from "./test-support.ts";

test("audit exports through the real CLI and verifies offline without reading credentials", async () => {
	await withInstance(async ({ cli, run, client, directory }) => {
		await client.call("propose", { edits: [{ op: "create", outline: "Audit from the CLI" }] });
		await client.call("report", ciReport({ commit: "closed-in-cli-audit", pr: 326, n: 1 }));
		await client.call("change", { change: "pr:326", state: "merged" });
		const file = join(directory, "audit.ndjson");
		const exported = await cli(["audit", "export", "--out", file]);
		expect(exported.code).toBe(0);
		expect(exported.stderr).toBe("");
		expect(exported.stdout).toContain("audit records");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const original = await Bun.file(file).text();
		expect(
			original
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		).toContainEqual(expect.objectContaining({ type: "change-end", key: "pr:326", state: "merged", repo: "acme/web" }));
		expect(verifyAudit(original)).toMatchObject({ project: "scratch", unavailableDecisionEvidence: 0 });
		const receipt = original
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.find((row) => row.type === "merge-receipt").receipt;
		const pageFile = join(directory, "receipt.ndjson");
		const page = await run([
			"audit",
			"export",
			"--out",
			pageFile,
			"--receipt",
			String(receipt.id),
			"--limit",
			"1",
			"--json",
		]);
		expect(page.code).toBe(0);
		expect(JSON.parse(page.stdout)).toMatchObject({ snapshot: receipt.snapshot, cursor: expect.any(String) });
		expect(verifyAudit(await Bun.file(pageFile).text()).records).toBe(1);
		const checked = await run(["audit", "verify", file, "--json"], {
			env: { MAINWORTHY_URL: "invalid", MAINWORTHY_TOKEN_FILE: "/does-not-exist" },
		});
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.stdout)).toMatchObject({ project: "scratch", unavailableDecisionEvidence: 0 });
		const rows = original
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		rows.pop();
		const decision = rows.find((row) => row.type === "decision");
		decision.signers[0].policy = 999999;
		const body = `${rows.map((row) => canonicalJson(row)).join("\n")}\n`;
		await writeFile(
			file,
			`${body}${canonicalJson({ end: true, records: rows.length - 1, sha256: auditChecksum(body) })}\n`,
		);
		const missingPolicy = await run(["audit", "verify", file]);
		expect(missingPolicy.code).toBe(4);
		expect(missingPolicy.stdout).toBe("");
		expect(missingPolicy.stderr).toContain(`record ${decision.id}: unresolved signing policy policy:999999`);
		rows[0].from = 1;
		const partialBody = `${rows.map((row) => canonicalJson(row)).join("\n")}\n`;
		await writeFile(
			file,
			`${partialBody}${canonicalJson({ end: true, records: rows.length - 1, sha256: auditChecksum(partialBody) })}\n`,
		);
		const partial = await run(["audit", "verify", file]);
		expect(partial.code).toBe(0);
		expect(partial.stdout).toContain("0 references precede the range; 1 signing policy references are omitted");
		const partialJson = await run(["audit", "verify", file, "--json"]);
		expect(partialJson.code).toBe(0);
		expect(JSON.parse(partialJson.stdout)).toMatchObject({
			beforeRangeReferences: 0,
			omittedSigningPolicyReferences: 1,
		});
		await writeFile(file, `\uFEFF${original}`);
		const bom = await run(["audit", "verify", file]);
		expect(bom.code).toBe(4);
		expect(bom.stderr).toContain("invalid audit: line 1 header: byte-order mark is not allowed");
		await writeFile(file, original);
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
