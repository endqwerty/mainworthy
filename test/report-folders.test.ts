// A report under the `create` rule makes a case for each test with no case, in the folder its file names. Each file
// is its own proposal, and a report of many files in folders that do not exist yet creates many folders: the
// project's folders are read once for the report and kept current as it creates them, not read again per file
// and per folder on the way down (#979).
import { expect, spyOn, test } from "bun:test";
import { budget } from "../scripts/budget.ts";
import type { ReportReceipt } from "../src/core/ops.ts";
import type { WriteDb } from "../src/server/kernel/db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

const FILES = 50;

type Folder = { path: string; state: string; cases: number };

const folders = async (h: Harness) =>
	new Map((await h.call<{ items: Folder[] }>("find", { in: "folders" })).items.map((folder) => [folder.path, folder]));
const titlesIn = async (h: Harness, folder: string) =>
	(await h.call<{ items: { title: string }[] }>("find", { in: "cases", folder })).items
		.map((item) => item.title)
		.sort();

/** One test in each of `FILES` files, each file in a folder of its own two levels under `pkg`. */
function nestedReport() {
	const results = Array.from({ length: FILES }, (_, i) => {
		const [result] = ciReport({ commit: "nested01", n: 1, file: `pkg/area-${i}/deep/file.spec.ts` }).results;
		if (!result) throw new Error("expected one result");
		return { ...result, test: { ...result.test, key: `${result.test.file}::test ${i}`, name: `test ${i}` } };
	});
	return { ...ciReport({ commit: "nested01", n: 0 }), results };
}

test("a report creating cases in many new folders reads the project's folders once, and places them as before", async () => {
	const h = await harness({ unlinked: "create" });
	try {
		// Before the report: a case in a folder the report also names, a case moved into another, and an archived
		// folder the report creates a folder under.
		await h.call("propose", { edits: [{ op: "create", body: { title: "Kept" }, folder: "pkg/area-2/deep" }] });
		await h.call("propose", { edits: [{ op: "create", body: { title: "Moved" } }] });
		const moved = (await h.call<{ items: { ref: string; title: string }[] }>("find", { in: "cases" })).items.find(
			(item) => item.title === "Moved",
		);
		if (!moved) throw new Error("expected the case to move");
		await h.call("propose", { edits: [{ op: "place", cases: [moved.ref], folder: "pkg/area-3/deep" }] });
		await h.call("propose", { edits: [{ op: "folder", name: "area-1", parent: "pkg" }] });
		await h.call("propose", { edits: [{ op: "folder", folder: "pkg/area-1", archive: true }] });
		const before = await folders(h);

		const all = spyOn(await h.app.database.write((db) => Object.getPrototypeOf(db) as WriteDb), "all");
		let receipt: ReportReceipt;
		try {
			h.app.database.resetStatementCount();
			receipt = await h.call<ReportReceipt>("report", nestedReport());
			const reads = all.mock.calls.filter(
				([statement]) =>
					statement.text.includes("FROM folders WHERE project") && statement.text.includes("NULLS FIRST"),
			).length;
			console.log(
				`report creating cases in ${FILES} new folders: ${reads} folder index reads, ${h.app.database.statementCount} database statements`,
			);
			budget(`folder index reads of a report creating cases in ${FILES} new folders`, reads, 1, "reads");
		} finally {
			all.mockRestore();
		}
		expect(receipt.counts.total).toBe(FILES);

		const after = await folders(h);
		const expected = new Set(["pkg", "Unsorted"]);
		for (let i = 0; i < FILES; i++) expected.add(`pkg/area-${i}`).add(`pkg/area-${i}/deep`);
		expect(new Set(after.keys())).toEqual(expected);
		for (const [path, folder] of before) expect(after.get(path)?.state).toBe(folder.state);
		expect(after.get("pkg/area-1")?.state).toBe("archived");
		expect(after.get("pkg/area-1/deep")?.state).toBe("active");
		for (let i = 0; i < FILES; i++) {
			const extra = i === 2 ? ["Kept"] : i === 3 ? ["Moved"] : [];
			expect(await titlesIn(h, `pkg/area-${i}/deep`)).toEqual([...extra, `test ${i}`].sort());
		}
	} finally {
		await h.close();
	}
}, 60_000);
