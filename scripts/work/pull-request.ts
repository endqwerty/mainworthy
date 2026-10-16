// What a pull request's description and milestone must say for GitHub, the board and the owner to agree
// (AGENTS.md, "Issues, pull requests and the board"). `bun scripts/work.ts pr-body <number>` runs it by hand, and
// `.github/workflows/pull-request.yml` runs it on every pull request.
//
// GitHub links a pull request to an issue on any closing word before the issue's number: "the closed #88" in a
// description once closed an issue nobody meant. So a closing word is allowed only on a line of its own
// (`Closes #123`), and what GitHub says it linked must be exactly those issues.
import { REPO } from "./board.ts";
import { read } from "./run.ts";

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
const OWN_LINE = /^(?:Closes|Fixes|Resolves) #(\d+)$/;
const PART_OF = /^Part of #(\d+)$/gim;

/** Code is not read by GitHub for links, and is not read here. */
const prose = (body: string): string => body.replace(/^```.*?^```/gms, "").replace(/`[^`\n]*`/g, "");

/** The issue numbers a line of their own closes, and the closing words that are anywhere else. */
export function closing(body: string): { closes: number[]; stray: string[] } {
	const text = prose(body).replaceAll("\r", "");
	const closes = text.split("\n").flatMap((line) => {
		const match = OWN_LINE.exec(line.trim());
		return match?.[1] ? [Number(match[1])] : [];
	});
	const stray = text
		.split("\n")
		.filter((line) => !OWN_LINE.test(line.trim()))
		.flatMap((line) => [...line.matchAll(CLOSING)].map((match) => match[0]));
	return { closes, stray };
}

export const partOf = (body: string): number[] => [...prose(body).matchAll(PART_OF)].map((match) => Number(match[1]));

export type Facts = {
	body: string;
	base: string;
	milestone: string | null;
	/** What GitHub linked as closed by this pull request. */
	linked: readonly number[];
	/** The milestone of each issue the description names, by number. */
	issueMilestones: ReadonlyMap<number, string | null>;
};

/** One sentence per thing that is wrong; empty when the pull request is in order. */
export function problems(facts: Facts): string[] {
	const found: string[] = [];
	const { closes, stray } = closing(facts.body);
	for (const text of stray)
		found.push(
			`"${text}" makes GitHub close that issue. Write \`Closes #N\` on a line of its own, or "issue #N, which is closed".`,
		);
	if (facts.base === "main") {
		const wanted = [...new Set(closes)].sort((a, b) => a - b);
		const got = [...new Set(facts.linked)].sort((a, b) => a - b);
		if (wanted.join() !== got.join())
			found.push(
				`GitHub links ${got.length ? got.map((n) => `#${n}`).join(", ") : "no issue"}; the description closes ${wanted.length ? wanted.map((n) => `#${n}`).join(", ") : "none"}.`,
			);
	}
	const named = [...new Set([...closes, ...partOf(facts.body)])];
	const milestones = [...new Set(named.map((n) => facts.issueMilestones.get(n)).filter((m): m is string => !!m))];
	if (milestones.length > 0 && (facts.milestone === null || !milestones.includes(facts.milestone)))
		found.push(
			`The pull request has ${facts.milestone ? `milestone "${facts.milestone}"` : "no milestone"}; its issue has ${milestones.map((m) => `"${m}"`).join(" or ")}.`,
		);
	return found;
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (typeof value === "object" && value !== null ? (value as Json) : {});

/** Reads a pull request and the issues it names from GitHub. */
export async function gather(number: number, gh = (args: string[]) => read(["gh", ...args])): Promise<Facts> {
	const pull = object(
		JSON.parse(
			await gh([
				"pr",
				"view",
				String(number),
				"--repo",
				REPO,
				"--json",
				"body,baseRefName,milestone,closingIssuesReferences",
			]),
		),
	);
	const body = typeof pull.body === "string" ? pull.body : "";
	const linked = (Array.isArray(pull.closingIssuesReferences) ? pull.closingIssuesReferences : []).map((issue) =>
		Number(object(issue).number),
	);
	const named = [...new Set([...closing(body).closes, ...partOf(body)])];
	const issueMilestones = new Map<number, string | null>();
	for (const n of named) {
		const title = (await gh(["api", `repos/${REPO}/issues/${n}`, "--jq", ".milestone.title // empty"])).trim();
		issueMilestones.set(n, title || null);
	}
	const milestone = object(pull.milestone).title;
	return {
		body,
		base: String(pull.baseRefName),
		milestone: typeof milestone === "string" ? milestone : null,
		linked,
		issueMilestones,
	};
}
