// What a pull request's description and milestone must say for GitHub, the board and the owner to agree
// (AGENTS.md, "Issues, pull requests and the board"). `bun scripts/work.ts pr-body <number>` runs it by hand, and
// the `description` job of `.github/workflows/check.yml` runs it on every pull request.
//
// GitHub links a pull request to an issue on any closing word before the issue's number: "the closed #88" in a
// description once closed an issue nobody meant. So a closing word is allowed only on a line of its own
// (`Closes #123`), and what GitHub says it linked must be exactly those issues.
import { opensBrowser, testDeclarations } from "../browser-tests.ts";
import { REPO } from "./board.ts";
import { read } from "./run.ts";

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
const OWN_LINE = /^(?:Closes|Fixes|Resolves) #(\d+)$/;
const PART_OF = /^Part of #(\d+)$/gim;

// A fence the description ends inside runs to the end of it.
const unfenced = (body: string): string =>
	body.replace(/^ {0,3}(`{3,}|~{3,}).*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gms, "");

/**
 * Fenced code and inline code are not read by GitHub for links, and are not read here. An indented line is not
 * taken for code (in a list it is not): a closing word there is read, and the way out is to write it differently.
 */
const prose = (body: string): string => unfenced(body).replace(/`[^`\n]*`/g, "");

/** The issue numbers a line of their own closes, and the closing words that are anywhere else. */
export function closing(body: string): { closes: number[]; stray: string[] } {
	const text = prose(body).replaceAll("\r", "");
	const closes = text.split("\n").flatMap((line) => {
		const match = OWN_LINE.exec(line.trimEnd());
		return match?.[1] ? [Number(match[1])] : [];
	});
	const stray = text
		.split("\n")
		.filter((line) => !OWN_LINE.test(line.trimEnd()))
		.flatMap((line) => [...line.matchAll(CLOSING)].map((match) => match[0]));
	return { closes, stray };
}

export const partOf = (body: string): number[] => [...prose(body).matchAll(PART_OF)].map((match) => Number(match[1]));

// A test sits at the cheapest layer that reaches it (AGENTS.md): a browser test only for what a browser alone shows.
// So a pull request that adds one says why, on a line of the description that starts with this.
const BROWSER_REASON = /^Browser tests: \S/m;

export type Facts = {
	pull: { url: string; draft: boolean };
	addedFragments: readonly { file: string; text: string }[];
	/** Each browser test file that declares more tests at the head than at the base. */
	addedBrowserTests: readonly { file: string; before: number; after: number }[];
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
	if (facts.addedBrowserTests.length > 0 && !BROWSER_REASON.test(prose(facts.body))) {
		const n = facts.addedBrowserTests.reduce((sum, { before, after }) => sum + after - before, 0);
		const files = facts.addedBrowserTests.map(({ file, before, after }) => `${file}: ${before} → ${after}`);
		found.push(
			`This pull request adds ${n} browser test${n === 1 ? "" : "s"} (${files.join("; ")}). Move each to the cheapest layer that reaches it, or say on a line starting "Browser tests:" what it checks that a unit, database or server test cannot (focus, keys, rendering, several windows, the content security policy).`,
		);
	}
	for (const { file, text } of facts.addedFragments) {
		// The description job installs no dependencies. Full fragment validation stays with the docs checks.
		const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1] ?? "";
		const refs = [...header.matchAll(/^pr: ([^\n]+)$/gm)];
		const ref = refs[0]?.[1];
		if (refs.length !== 1 || (ref !== facts.pull.url && !(facts.pull.draft && ref === "pending")))
			found.push(
				`${file} must name this pull request as \`pr: ${facts.pull.url}\`; pending is allowed only while the pull request is a draft.`,
			);
	}
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
				"body,baseRefName,milestone,closingIssuesReferences,isDraft,headRefOid,baseRefOid",
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
	if (
		typeof pull.isDraft !== "boolean" ||
		typeof pull.headRefOid !== "string" ||
		!/^[a-f0-9]{40}$/.test(pull.headRefOid)
	)
		throw new Error("GitHub did not return the pull request's draft state and head commit");
	const pages: unknown = JSON.parse(await gh(["api", `repos/${REPO}/pulls/${number}/files`, "--paginate", "--slurp"]));
	if (!Array.isArray(pages)) throw new Error("GitHub returned an invalid paginated file list");
	const paths: string[] = [];
	const browserFiles: { file: string; previous: string }[] = [];
	const fragment = (file: string): boolean => file.startsWith(".changes/") && file.endsWith(".md");
	const changes = pages.flatMap((page) => {
		if (!Array.isArray(page)) throw new Error("GitHub returned an invalid page in the file list");
		return page;
	});
	const total: unknown = JSON.parse(await gh(["api", `repos/${REPO}/pulls/${number}`, "--jq", ".changed_files"]));
	if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
		throw new Error("GitHub did not return a valid total changed-file count");
	if (changes.length !== total)
		throw new Error(`GitHub returned ${changes.length} of ${total} changed files; refusing an incomplete file list.`);
	for (const row of changes) {
		const change = object(row);
		const file = change.filename;
		const status = change.status;
		const previous = change.previous_filename;
		if (
			typeof file !== "string" ||
			!file ||
			typeof status !== "string" ||
			!status ||
			(previous !== undefined && typeof previous !== "string") ||
			(status === "renamed" && (typeof previous !== "string" || !previous))
		)
			throw new Error("GitHub file list lacks a filename, status or rename source");
		if (
			["added", "renamed", "copied"].includes(status) &&
			file.startsWith("docs/decisions/") &&
			file.endsWith(".md") &&
			!/^docs\/decisions\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)
		)
			throw new Error(`${file}: new decisions must use dated filenames, including when a historical number is unused`);
		if (status !== "removed" && opensBrowser(file)) browserFiles.push({ file, previous: previous ?? file });
		if (!fragment(file) && !(typeof previous === "string" && fragment(previous))) continue;
		if (status !== "added")
			throw new Error(
				`${previous ?? file}: retained fragments are immutable (${status}); add a new fragment to correct an old entry.`,
			);
		paths.push(file);
	}
	const raw = async (file: string, ref: string): Promise<string> => {
		const path = file.split("/").map(encodeURIComponent).join("/");
		return gh([
			"api",
			`repos/${REPO}/contents/${path}?ref=${ref}`,
			"--header",
			"Accept: application/vnd.github.raw+json",
		]);
	};
	const baseRef = pull.baseRefOid;
	if (browserFiles.length > 0 && (typeof baseRef !== "string" || !/^[a-f0-9]{40}$/.test(baseRef)))
		throw new Error("GitHub did not return the pull request's base commit");
	const addedBrowserTests: Facts["addedBrowserTests"][number][] = [];
	for (const { file, previous } of browserFiles) {
		const after = testDeclarations(await raw(file, pull.headRefOid));
		// A file the base does not have yet declares nothing there.
		const before = await raw(previous, String(baseRef)).then(testDeclarations, (error: unknown) => {
			if (/\b404\b|Not Found/.test(String(error))) return 0;
			throw error;
		});
		if (after > before) addedBrowserTests.push({ file, before, after });
	}
	const addedFragments: Facts["addedFragments"][number][] = [];
	for (const file of paths) {
		addedFragments.push({ file, text: await raw(file, pull.headRefOid) });
	}
	const milestone = object(pull.milestone).title;
	return {
		pull: { url: `https://github.com/${REPO}/pull/${number}`, draft: pull.isDraft },
		addedFragments,
		addedBrowserTests,
		body,
		base: String(pull.baseRefName),
		milestone: typeof milestone === "string" ? milestone : null,
		linked,
		issueMilestones,
	};
}
