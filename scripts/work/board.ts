// The project board (https://github.com/users/endqwerty/projects/2): the one place that knows its ids. An agent
// that starts on an issue or opens a pull request moves the card with `bun scripts/work.ts board start <number>`
// and does not copy ids out of a document. `board check` reads the board and says which of these ids moved.
import { read } from "./run.ts";

export const REPO = "endqwerty/mainworthy";
export const BOARD = {
	owner: "endqwerty",
	number: 2,
	projectId: "PVT_kwHOAArmbc4Bm7Xt",
	statusField: "PVTSSF_lAHOAArmbc4Bm7XtzhliU7A",
	/** Status name on the board, by the word the command takes. */
	statuses: {
		start: { id: "47fc9ee4", name: "In Progress" },
		todo: { id: "f75ad846", name: "Todo" },
		done: { id: "98236657", name: "Done" },
	},
} as const;

export type Move = keyof typeof BOARD.statuses;
export const isMove = (word: string): word is Move => Object.hasOwn(BOARD.statuses, word);

/** The `gh` arguments that put an item on the board, and the ones that set its status once its id is known. */
export const addArgs = (url: string): string[] => [
	"project",
	"item-add",
	String(BOARD.number),
	"--owner",
	BOARD.owner,
	"--url",
	url,
	"--format",
	"json",
	"--jq",
	".id",
];

export const editArgs = (item: string, move: Move): string[] => [
	"project",
	"item-edit",
	"--id",
	item,
	"--project-id",
	BOARD.projectId,
	"--field-id",
	BOARD.statusField,
	"--single-select-option-id",
	BOARD.statuses[move].id,
];

/** An issue's or a pull request's page, from its number or from the address given. */
export async function pageOf(target: string): Promise<string> {
	if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+$/.test(target)) return target;
	if (!/^\d+$/.test(target)) throw new Error(`${target} is neither an issue or pull request number nor its address`);
	return read(["gh", "api", `repos/${REPO}/issues/${target}`, "--jq", ".html_url"]);
}

/** Puts the item on the board when it is not there, and sets its status. */
export async function move(target: string, to: Move): Promise<string> {
	const url = await pageOf(target);
	const item = await read(["gh", ...addArgs(url)]);
	await read(["gh", ...editArgs(item, to)]);
	return `${url} is ${BOARD.statuses[to].name} on the board`;
}

type Field = { id?: string; options?: { id?: string; name?: string }[] };

/** What differs between the ids above and the board's fields, one sentence each; empty when they agree. */
export function drift(projectId: string, fields: readonly Field[]): string[] {
	const problems: string[] = [];
	if (projectId !== BOARD.projectId) problems.push(`the project's id is ${projectId}, not ${BOARD.projectId}`);
	const status = fields.find((field) => field.id === BOARD.statusField);
	if (!status) return [...problems, `the board has no field ${BOARD.statusField}`];
	for (const [word, expected] of Object.entries(BOARD.statuses)) {
		const option = status.options?.find((candidate) => candidate.name === expected.name);
		if (option?.id !== expected.id)
			problems.push(
				`"${expected.name}" (${word}) is option ${option?.id ?? "missing"} on the board, not ${expected.id}`,
			);
	}
	return problems;
}

export async function check(): Promise<string[]> {
	const where = ["--owner", BOARD.owner, "--format", "json"];
	const project: unknown = JSON.parse(await read(["gh", "project", "view", String(BOARD.number), ...where]));
	const fields: unknown = JSON.parse(await read(["gh", "project", "field-list", String(BOARD.number), ...where]));
	const id = typeof project === "object" && project !== null ? Reflect.get(project, "id") : undefined;
	const list = typeof fields === "object" && fields !== null ? Reflect.get(fields, "fields") : undefined;
	return drift(typeof id === "string" ? id : "", Array.isArray(list) ? list : []);
}
