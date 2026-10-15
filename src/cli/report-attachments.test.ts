import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportInput } from "../core/ops.ts";
import { parseJUnit } from "../surfaces/formats/junit.ts";
import { loadReportAttachments } from "./report-attachments.ts";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-report-files-"));
	directories.push(dir);
	return dir;
}
const parsed = () =>
	parseJUnit(
		'<testsuite><testcase name="failed"><failure message="bad"/><system-out>[[ATTACHMENT|screen.png]]</system-out><properties><property name="attachment.1" value="detail.txt"/></properties></testcase></testsuite>',
	);

test("JUnit path markers and numbered properties become bounded report attachments", () => {
	const root = directory();
	writeFileSync(join(root, "screen.png"), "screenshot");
	writeFileSync(join(root, "detail.txt"), "diagnostic");
	const budget = { bytes: 0, files: 0 };
	expect(parsed().results[0]?.attachmentPaths).toEqual(["screen.png", "detail.txt"]);
	const result = loadReportAttachments(parsed(), join(root, "results.xml"), root, budget).results[0];
	expect(result?.attachments).toEqual([
		{ name: "screen.png", data: Buffer.from("screenshot").toString("base64") },
		{ name: "detail.txt", data: Buffer.from("diagnostic").toString("base64") },
	]);
	expect(result).not.toHaveProperty("attachmentPaths");
	expect(budget).toEqual({ bytes: 20, files: 2 });
});

test("unavailable or disallowed files are skipped without losing results", () => {
	const root = directory();
	const outside = directory();
	writeFileSync(join(outside, "secret"), "private");
	const load = (path: string, permitted: string | undefined = root) =>
		loadReportAttachments(
			parseJUnit(
				`<testsuite><testcase name="one"><properties><property name="attachment" value="${path}"/></properties></testcase></testsuite>`,
			),
			join(root, "results.xml"),
			permitted,
			{ bytes: 0, files: 0 },
		);
	const ignored = loadReportAttachments(parsed(), join(root, "results.xml"), undefined, { bytes: 0, files: 0 });
	expect(ignored.results[0]).toMatchObject({ outcome: "fail", test: { key: "failed" } });
	expect(ignored.skipped).toBe(2);
	writeFileSync(join(root, ".env"), "private");
	symlinkSync(join(outside, "secret"), join(root, "link"));
	mkdirSync(join(root, "directory"));
	for (const path of [join(outside, "secret"), "../outside", ".env", "link", "missing", "directory"]) {
		const loaded = load(path);
		expect(loaded.results).toEqual([{ test: { key: "one", name: "one" }, outcome: "pass" }]);
		expect(loaded.skipped).toBe(1);
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toContain(JSON.stringify(path));
	}
	writeFileSync(join(root, "large.bin"), Buffer.alloc(4 * 1024 ** 2 + 1));
	expect(load("large.bin")).toMatchObject({ skipped: 1, warnings: [expect.stringContaining("4 MiB")] });
	expect(load("screen.png", join(root, "unavailable"))).toMatchObject({
		skipped: 1,
		warnings: [expect.stringContaining("attachment directory is unavailable")],
	});
	const longName = "a".repeat(201);
	writeFileSync(join(root, longName), "file");
	expect(load(longName)).toMatchObject({ skipped: 1, warnings: [expect.stringContaining(longName)] });
	writeFileSync(join(root, "target.txt"), "file");
	symlinkSync(join(root, "target.txt"), join(root, "alias.txt"));
	expect(load("alias.txt").results[0]?.attachments).toEqual([{ name: "alias.txt", data: "ZmlsZQ==" }]);
});

test("JUnit markers survive CDATA boundaries and stay with their own testcase", () => {
	const report = parseJUnit(
		'<testsuite><system-out>[[ATTACHMENT|orphan]]</system-out><testcase name="one"><system-out><![CDATA[[[ATTACH]]><![CDATA[MENT|screen.png]]\n]]></system-out></testcase><testcase name="two"><system-out>ordinary log</system-out></testcase></testsuite>',
	);
	expect(report.results[0]?.attachmentPaths).toEqual(["screen.png"]);
	expect(report.results[1]?.attachmentPaths).toBeUndefined();
});

test("skipped files consume no budget and count and byte limits preserve all results", () => {
	const root = directory();
	writeFileSync(join(root, "large.bin"), Buffer.alloc(6 * 1024 ** 2));
	writeFileSync(join(root, "trace.zip"), "trace");
	writeFileSync(join(root, "full.bin"), Buffer.alloc(4 * 1024 ** 2));
	const input = parseJUnit(
		'<testsuite><testcase name="video"><failure/><system-out>[[ATTACHMENT|large.bin]]\n[[ATTACHMENT|trace.zip]]</system-out></testcase></testsuite>',
	);
	const budget = { bytes: 0, files: 0 };
	const loaded = loadReportAttachments(input, join(root, "results.xml"), root, budget);
	expect(loaded.results[0]?.attachments).toEqual([{ name: "trace.zip", data: "dHJhY2U=" }]);
	expect(budget).toEqual({ bytes: 5, files: 1 });
	expect(loaded.skipped).toBe(1);
	const many = {
		results: Array.from({ length: 6 }, (_, i) => ({
			test: { key: `test-${i}` },
			outcome: "pass" as const,
			attachmentPaths: Array(21).fill("trace.zip"),
		})),
		warnings: [],
	};
	const counted = loadReportAttachments(many, join(root, "results.xml"), root, { bytes: 0, files: 0 });
	expect(counted.results).toHaveLength(6);
	expect(counted.results.map((r) => r.attachments?.length ?? 0)).toEqual([20, 20, 20, 20, 20, 0]);
	expect(ReportInput.parse({ target: { session: "counted" }, results: counted.results }).results).toHaveLength(6);
	expect(counted.skipped).toBe(26);
	expect(counted.warnings).toHaveLength(26);
	const bytes = { bytes: 0, files: 0 };
	const filled = loadReportAttachments(
		{
			results: [
				{ test: { key: "filled" }, outcome: "pass", attachmentPaths: [...Array(5).fill("full.bin"), "trace.zip"] },
			],
			warnings: [],
		},
		join(root, "results.xml"),
		root,
		bytes,
	);
	expect(filled.results[0]?.attachments).toHaveLength(4);
	expect(bytes).toEqual({ bytes: 16 * 1024 ** 2, files: 4 });
	expect(
		ReportInput.parse({ target: { session: "filled" }, results: filled.results }).results[0]?.attachments,
	).toHaveLength(4);
	expect(filled.skipped).toBe(2);
	const next = loadReportAttachments(input, join(root, "second.xml"), root, bytes);
	expect(next.results[0]?.outcome).toBe("fail");
	expect(next.skipped).toBe(2);
});
