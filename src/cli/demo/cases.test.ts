// The demo's cases: distinct, grouped the way the catalog groups them, and the same for the same seed.
import { describe, expect, test } from "bun:test";
import { StepId } from "../../core/model.ts";
import { automatedCount, demoCases } from "./cases.ts";
import { CATALOG, CONTEXTS } from "./catalog.ts";

const titles = (seed: number, count: number) => demoCases(seed, count).map((item) => item.title);

describe("the demo's cases", () => {
	test("the same seed gives the same cases, and another seed gives others", () => {
		expect(demoCases(7, 400)).toEqual(demoCases(7, 400));
		expect(titles(7, 400)).not.toEqual(titles(8, 400));
	});

	test("no two cases share a title, at the default size and at the largest", () => {
		for (const count of [2000, 100_000]) expect(new Set(titles(1, count)).size).toBe(count);
	});

	test("at the default size no title needs a number to be its own", () => {
		expect(titles(1, 2000).filter((title) => /\d{5}$/.test(title))).toEqual([]);
	});

	test("every case has a title, steps with ids of their own, and no slot left unfilled", () => {
		for (const item of demoCases(3, 2000)) {
			const text = [item.title, item.pre, ...item.steps.flatMap((step) => [step.action, step.expected ?? ""])];
			expect(text.join("\n")).not.toMatch(/[{}]/);
			expect(item.title.length).toBeGreaterThan(0);
			expect(item.steps.length).toBeGreaterThan(0);
			const ids = item.steps.map((step) => step.id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) expect(StepId.safeParse(id).success).toBe(true);
		}
	});

	test("the steps of a case are those of its scenario, not of another feature's", () => {
		const suite = demoCases(1, 2000);
		const reset = suite.find((item) => item.title === "Password reset restores access");
		expect(reset?.folder).toBe("Accounts/Password reset");
		expect(reset?.steps.map((step) => step.action).join(" ")).toContain("reset link");
		// What the old demo did: one body under every title.
		expect(new Set(suite.map((item) => JSON.stringify(item.steps))).size).toBeGreaterThan(500);
	});

	test("the cases are grouped in the catalog's folders, a larger share to a feature with more weight", () => {
		const suite = demoCases(1, 2000);
		const perFolder = new Map<string, number>();
		for (const item of suite) perFolder.set(item.folder, (perFolder.get(item.folder) ?? 0) + 1);
		expect([...perFolder.keys()]).toEqual(CATALOG.map((feature) => feature.path));
		const heaviest = CATALOG.toSorted((a, b) => b.weight - a.weight)[0];
		const lightest = CATALOG.toSorted((a, b) => a.weight - b.weight)[0];
		expect(perFolder.get(heaviest?.path ?? "")).toBeGreaterThan(3 * (perFolder.get(lightest?.path ?? "") ?? 0));
		// A folder's cases are together: the list never comes back to a folder it left.
		const order = suite.map((item) => item.folder).filter((folder, index, all) => folder !== all[index - 1]);
		expect(order).toEqual([...perFolder.keys()]);
	});

	test("a case is repeated only for what its feature can vary: an API has no browser", () => {
		const everywhere = [...CONTEXTS.platform, ...CONTEXTS.language, ...CONTEXTS.customer];
		for (const item of demoCases(1, 100_000)) {
			if (!item.folder.startsWith("API/")) continue;
			const context = item.title.split(" · ")[1] ?? "";
			expect(everywhere.filter((name) => context.includes(name))).toEqual([]);
		}
		const office = demoCases(1, 2000).filter((item) => item.folder.startsWith("Back office/"));
		expect(office.filter((item) => CONTEXTS.platform.some((name) => item.title.includes(name)))).toEqual([]);
	});

	test("the first case is the one the open questions are about, whatever the seed and the size", () => {
		for (const [seed, count] of [
			[1, 1],
			[9, 3],
			[123, 2000],
		] as const) {
			const first = demoCases(seed, count)[0];
			expect(first).toMatchObject({ folder: "Checkout/Coupons", title: "Expired coupon is rejected" });
			expect(first?.steps.map((step) => step.id)).toEqual(["a1", "b2", "c3"]);
			expect(first?.test).not.toBeNull();
		}
	});

	test("about a third of the cases are automated, each by a test of its own", () => {
		for (const count of [1, 5, 40, 2000, 10_000]) {
			const automated = demoCases(1, count).flatMap((item) => (item.test ? [item.test.key] : []));
			expect(automated.length).toBe(automatedCount(count));
			expect(new Set(automated).size).toBe(automated.length);
		}
		expect(automatedCount(2000)).toBe(600);
		expect(automatedCount(100_000)).toBe(600);
	});
});
