import { expect, test } from "bun:test";
import { allOfKind, named, type Row, rangeOf, sharedAnswers, whyNotSelectable } from "./selection.ts";

const failure = (q: string, more: Partial<Row> = {}): Row => ({
	q,
	kind: "failure",
	you: "counts",
	answers: ["defect", "test", "expected", "flaky", "infra"],
	...more,
});
const unlinked = (q: string): Row => ({ q, kind: "map", you: "counts", answers: ["link", "create", "track"] });

test("a question joins a selection of its own kind that you may answer", () => {
	expect(whyNotSelectable(failure("Q-1"), [])).toBeNull();
	expect(whyNotSelectable(failure("Q-2"), [failure("Q-1")])).toBeNull();
	expect(whyNotSelectable(unlinked("Q-3"), [failure("Q-1")])).toBe(
		"Q-3 is unlinked and the selection is of failures: one answer is for one kind.",
	);
	expect(whyNotSelectable(failure("Q-4", { you: "forbidden" }), [])).toBe("You cannot settle Q-4.");
});

test("a range takes the rows between the two that may join, and counts the rest", () => {
	const items = [failure("Q-1"), failure("Q-2"), unlinked("Q-3"), failure("Q-4", { you: "forbidden" }), failure("Q-5")];
	expect(rangeOf(items, [], "Q-1", "Q-5")).toEqual({ refs: ["Q-1", "Q-2", "Q-5"], skipped: 2 });
	expect(rangeOf(items, [], "Q-5", "Q-1")).toEqual({ refs: ["Q-1", "Q-2", "Q-5"], skipped: 2 });
	// The selection's kind wins over the kind of the row clicked first.
	expect(rangeOf(items, [unlinked("Q-3")], "Q-2", "Q-3")).toEqual({ refs: ["Q-3"], skipped: 1 });
	// An anchor no longer listed starts the range at the row clicked.
	expect(rangeOf(items, [], "Q-9", "Q-2")).toEqual({ refs: ["Q-2"], skipped: 0 });
});

test("select all takes every listed question of one kind you may answer", () => {
	const items = [failure("Q-1"), unlinked("Q-2"), failure("Q-3", { you: "forbidden" }), failure("Q-4")];
	expect(allOfKind(items, "failure")).toEqual(["Q-1", "Q-4"]);
	expect(allOfKind(items, "map")).toEqual(["Q-2"]);
	expect(allOfKind(items, "finding")).toEqual([]);
});

test("a selection is offered the answers every question in it takes, and links one at a time", () => {
	const onChange = failure("Q-2", { answers: ["defect", "test", "expected", "flaky", "infra", "inherited"] });
	const offered = sharedAnswers([failure("Q-1"), onChange]);
	expect(offered.map((answer) => answer.is)).toEqual([
		"defect",
		"test",
		"expected",
		"flaky",
		"infra",
		"inherited",
		"mistaken",
	]);
	expect(offered.filter((answer) => answer.why === null).map((answer) => answer.key)).toEqual([
		"d",
		"t",
		"e",
		"f",
		"i",
	]);
	expect(offered.find((answer) => answer.is === "inherited")?.why).toBe(
		"Not every selected question takes this answer.",
	);
	const two = sharedAnswers([unlinked("Q-3"), unlinked("Q-4")]);
	expect(two.find((answer) => answer.is === "link")?.why).toBe(
		"Link one question at a time so each test can have its own case.",
	);
	expect(two.find((answer) => answer.is === "track")?.why).toBeNull();
	expect(sharedAnswers([unlinked("Q-3")]).find((answer) => answer.is === "link")?.why).toBeNull();
	expect(sharedAnswers([])).toEqual([]);
});

test("a status line names up to three questions and counts more", () => {
	expect(named([failure("Q-1"), failure("Q-2"), failure("Q-3")])).toBe("Q-1, Q-2, Q-3");
	expect(named(["Q-1", "Q-2", "Q-3", "Q-4"].map(unlinked))).toBe("4 unlinked");
	expect(named([failure("Q-1"), failure("Q-2"), failure("Q-3"), failure("Q-4")])).toBe("4 failures");
});
