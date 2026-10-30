import { expect, test } from "bun:test";
import { ANSWER_HELP } from "./kinds.ts";
import { adoptHelp, proposalTally, proposalTitle } from "./proposals.ts";

test("proposal titles count operations across the whole proposal", () => {
	expect(
		proposalTitle(proposalTally(Array.from({ length: 201 }, () => ({ op: "create" }))), {
			op: "create",
			title: "First",
		}),
	).toBe("201 new cases");
	for (const [op, title] of [
		["edit", "Edit: Case"],
		["create", "New case: Case"],
		["restore", "Restore: Case"],
		["policy", "Policy change"],
		["cover", "1 coverage change"],
	] as const)
		expect(proposalTitle(proposalTally([{ op }]), { op, title: "Case" })).toBe(title);
	expect(proposalTitle({ create: 2, edit: 3, place: 1 })).toBe("2 new cases · 3 case edits · 1 placement change");
	expect(proposalTitle({ quarantine: 1 }, { op: "quarantine", test: "T-1", exit: null })).toBe("End quarantine T-1");
	expect(proposalTitle({ quarantine: 1 }, { op: "quarantine", test: "T-1", exit: {} })).toBe("Quarantine T-1");
});
test("answer help describes the whole proposal", () => {
	expect(adoptHelp({ facts: ["quarantine"] }).accept).toBe("Makes this the current version.");
	for (const [tally, accept, reject] of [
		[undefined, "Makes this the current version.", "Leaves the case as it is. The proposal stays in the history."],
		[{ edit: 1 }, "Makes this the current version.", "Leaves the case as it is. The proposal stays in the history."],
		[{ restore: 1 }, "Makes this the current version.", "Leaves the case as it is. The proposal stays in the history."],
		[{ create: 1 }, "Adds this case to the suite.", "Adds no case. The proposal stays in the history."],
		[{ create: 3 }, "Adds all 3 cases to the suite.", "Adds none of them. The proposal stays in the history."],
		[
			{ edit: 3 },
			"Makes the proposed version of each case current.",
			"Leaves every case as it is. The proposal stays in the history.",
		],
		[
			{ policy: 1 },
			"Puts the proposed policy in force.",
			"Leaves the policy as it is. The proposal stays in the history.",
		],
		[
			{ create: 2, place: 1 },
			"Applies every change in it at once.",
			"Applies none of it. The proposal stays in the history.",
		],
	] as const) {
		expect(adoptHelp({ tally, facts: [] })).toMatchObject({ accept, reject });
	}
	const quarantine = (exit: unknown) =>
		adoptHelp({ tally: { quarantine: 1 }, facts: ["quarantine"], edits: [{ op: "quarantine", test: "T-1", exit }] });
	expect(quarantine(null).accept).toBe("Ends the test's quarantine.");
	expect(quarantine({ at: 1 }).accept).toBe("Quarantines the test.");
	expect(adoptHelp(undefined)).toBe(ANSWER_HELP.adopt);
});
