// The demo project's own fields (decision 0052): a priority, the owning team and risk notes. Pure: a case's values
// come from its folder, so the same case has the same values in every demo.
import type { FieldDefinitions } from "../../core/model.ts";
import type { DemoCase } from "./cases.ts";
import { CATALOG } from "./catalog.ts";

export const DEMO_FIELDS: FieldDefinitions = {
	priority: { kind: "choice", label: "Priority", required: false, choices: ["P1", "P2", "P3"] },
	team: { kind: "text", label: "Team", required: false },
	risk: { kind: "text", label: "Risk", required: false },
};

/** Who owns each area of the shop. */
const TEAMS: Readonly<Record<string, string>> = {
	Checkout: "Checkout",
	Accounts: "Identity",
	Orders: "Orders",
	Catalog: "Discovery",
	"Back office": "Operations",
	Notifications: "Messaging",
	"Mobile app": "Mobile",
	API: "Platform",
};

/** The fields of a case: its feature's weight sets the priority (checkout is tested more), its area the team. */
export function demoFields(item: DemoCase): Record<string, string> {
	const weight = CATALOG.find((feature) => feature.path === item.folder)?.weight ?? 0;
	const area = item.folder.split("/")[0] ?? item.folder;
	return {
		priority: weight >= 8 ? "P1" : weight >= 5 ? "P2" : "P3",
		...(item.folder.startsWith("Checkout/") ? { risk: "Customer payments" } : {}),
		...(TEAMS[area] ? { team: TEAMS[area] } : {}),
	};
}

/**
 * The back office's cases came from TestRail when the team moved, and keep its id as an alias, as an import does:
 * `mainworthy get C5505` reads the case, and a report that names `@C5505` is about it.
 */
export function demoAliases(item: DemoCase, index: number): string[] {
	return item.folder.startsWith("Back office/") ? [`C${4000 + index}`] : [];
}
