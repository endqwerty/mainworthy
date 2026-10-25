// The parts of the user documentation that are read from the code: every table in `docs/guide/` between
// `<!-- generated:NAME -->` and `<!-- /generated -->`. The prose around a table is written by hand; the table is
// written here, from the same lists the product runs on, so it cannot say something the product does not do.
//
//   bun scripts/gen-docs.ts      rewrite the tables in place, after a change to what they are read from
//
// `test/docs.test.ts` fails when a committed table is not what this prints.
import { readdirSync, readFileSync } from "node:fs";
import { type Flag, GLOBAL_FLAGS } from "../src/cli/args.ts";
import { ADAPTER_COMMANDS } from "../src/cli/dispatch.ts";
import { GENERATED_COMMANDS } from "../src/cli/generated.ts";
import { DOC_SECTIONS, type DocSlug } from "../src/core/docs.ts";
import {
	ANSWER_HELP,
	ANSWER_KEYS,
	ANSWER_LABELS,
	Capability,
	CI_CAPABILITIES,
	defaultCapabilities,
	KINDS,
	type Kind,
	needs,
} from "../src/core/kinds.ts";
import { PRESET_GUIDE, PRESET_SUMMARY } from "../src/core/policy-guide.ts";
import { PRESET_NAMES, PRESETS } from "../src/core/presets.ts";
import { EXIT_CODE, Verdict } from "../src/core/runs.ts";
import { MCP_OPS, OP_LIST } from "../src/server/ops/index.ts";
import { inputSchemaForDocs, rows } from "./gen-skill.ts";

const GUIDE = new URL("../docs/guide/", import.meta.url);

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const table = (head: string[], body: string[][]): string =>
	[
		`| ${head.join(" | ")} |`,
		`| ${head.map(() => "---").join(" | ")} |`,
		...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
	].join("\n");
const code = (text: string): string => `\`${text}\``;
const key = (text: string): string => `<kbd>${text}</kbd>`;

/** What a question of each kind is about, in the words of the queue. */
const KIND_TITLES: Record<Kind, string> = {
	adopt: "A proposed edit (`adopt`)",
	map: "A test with no case (`map`)",
	failure: "A failed result (`failure`)",
	finding: "A finding from a review (`finding`)",
	signoff: "Closing a run (`signoff`)",
};

/** Every answer a kind has, with its key in the queue and the sentence the queue prints beside it. */
function answerKeys(): string {
	return KINDS.map((kind) => {
		const keys: Record<string, string> = ANSWER_KEYS[kind];
		const help: Record<string, string> = ANSWER_HELP[kind];
		const keyOf = (answer: string): string => {
			const found = Object.entries(keys).find(([, is]) => is === answer)?.[0];
			return found ? key(found) : "";
		};
		const answers = Object.keys(help);
		return [
			`### ${KIND_TITLES[kind]}`,
			"",
			table(
				["Key", "Answer", "What it does"],
				answers.map((answer) => [keyOf(answer), ANSWER_LABELS[answer] ?? answer, help[answer] ?? ""]),
			),
		].join("\n");
	}).join("\n\n");
}

/** The answer keys again, as the rows the Keys overlay lists on the queue: one table for every kind. */
function queueKeys(): string {
	return table(
		["Key", "Answer", "On a question about"],
		KINDS.flatMap((kind) =>
			Object.entries<string>(ANSWER_KEYS[kind]).map(([letter, answer]) => [
				key(letter),
				ANSWER_LABELS[answer] ?? answer,
				KIND_TITLES[kind].replace(/ \(.*$/, "").replace(/^./, (first) => first.toLowerCase()),
			]),
		),
	);
}

function policyPresets(): string {
	const holds = (name: (typeof PRESET_NAMES)[number]): string => {
		const { settings } = PRESETS[name];
		return `${settings.holds.flakyDays} days`;
	};
	const basis = (name: (typeof PRESET_NAMES)[number]): string =>
		PRESETS[name].settings.basis === "exact"
			? "Only a result that names the pinned version"
			: "Also a result assumed to be for the current version";
	return [
		table(
			["Preset", "In short"],
			PRESET_NAMES.map((name) => [code(name), PRESET_SUMMARY[name]]),
		),
		"",
		"Who answers each question:",
		"",
		table(
			["Question", ...PRESET_NAMES.map(code)],
			[
				...PRESET_GUIDE.map((row) => [row.question, ...PRESET_NAMES.map((name) => row.answeredBy[name])]),
				["How long a `flaky` answer carries forward", ...PRESET_NAMES.map(holds)],
				["What fills a slot of a planned run", ...PRESET_NAMES.map(basis)],
				["An empty report", ...PRESET_NAMES.map((name) => code(PRESETS[name].settings.emptyReports))],
			],
		),
	].join("\n");
}

function capabilities(): string {
	const kinds = [
		["human", "a person"],
		["agent", "an agent"],
		["ci", "a pipeline"],
	] as const;
	return table(
		["Capability", "Operations it allows", "Held by default by"],
		Capability.options.map((capability) => [
			code(capability),
			OP_LIST.filter((op) => op.effect !== "service" && needs(op.needs).includes(capability))
				.map((op) => code(op.name))
				.join(", ") || "none by itself; it makes an answer count where the policy asks a member",
			kinds
				.filter(([kind]) => defaultCapabilities(kind).includes(capability))
				.map(([, name]) => name)
				.join(", ") || "nobody",
		]),
	).concat(`\n\nA pipeline holds ${CI_CAPABILITIES.map(code).join(" and ")} at most, whatever its grant lists.`);
}

const flagShape = (flag: Flag): string =>
	flag.kind === "boolean"
		? ""
		: flag.kind === "json"
			? " <JSON>"
			: flag.kind === "strings"
				? " <a,b,...>"
				: ` <${flag.kind}>`;
const flagList = (flags: readonly Flag[]): string =>
	flags
		.map((flag) => `- ${code(`--${flag.name}${flagShape(flag)}`)}${flag.description ? `: ${flag.description}` : ""}`)
		.join("\n");

const adapters = await Promise.all([...ADAPTER_COMMANDS.values()].map((load) => load()));

function cliCommands(): string {
	const generated = [...GENERATED_COMMANDS.values()];
	return [
		"### Commands for people",
		"",
		"Each prints text made to be read, and `--json` where it is listed prints the same as JSON.",
		"",
		table(
			["Command", "What it does"],
			[
				[code("mainworthy serve"), "Start the server and web UI. Also the default with no arguments."],
				...adapters.map((command) => [code(`mainworthy ${command.usage}`), command.summary]),
				[code("mainworthy help"), "List every operation and adapter."],
			],
		),
		"",
		...adapters
			.filter((command) => command.flags.length > 0)
			.flatMap((command) => [`Flags of ${code(`mainworthy ${command.name}`)}:`, "", flagList(command.flags), ""]),
		"### One command per operation",
		"",
		"Every operation of the API is also a command with the same name. Give its input as flags, or whole as `--json '<input JSON>'`. Where a command for people has the same name, the operation form is the one that runs when you pass `--json` input.",
		"",
		table(
			["Command", "What it does"],
			generated.map((command) => [code(`mainworthy ${command.name}`), command.summary]),
		),
		"",
		"### Flags every command takes",
		"",
		flagList(GLOBAL_FLAGS),
		"",
		"### Exit codes",
		"",
		table(
			["Code", "Meaning"],
			[
				...Verdict.options.map((verdict) => [
					String(EXIT_CODE[verdict]),
					`${code("mainworthy gate")}: the verdict is ${code(verdict)}`,
				]),
				["1", "`mainworthy check` found problems in the suite; `mainworthy health` got no answer"],
				["4", "The command could not run: the server refused it, could not be reached, or the input was wrong"],
			],
		),
	].join("\n");
}

function operations(): string {
	return OP_LIST.map((op) => {
		const path = op.scope === "project" ? `/api/p/<project>/${op.name}` : `/api/${op.name}`;
		const schema = inputSchemaForDocs(op.input);
		const inputs = rows(schema);
		return [
			`### ${op.name}`,
			"",
			op.summary,
			"",
			table(
				["", ""],
				[
					["HTTP", code(`POST ${path}`)],
					["Command", code(`mainworthy ${op.name}`)],
					[
						"Needs",
						// `self` names no capability: the operation is about what is the caller's own.
						op.effect === "service"
							? "Google OIDC identity of the configured job service account; ordinary admin tokens are refused"
							: op.needs === "self"
								? "no capability: any person or agent that is signed in, for what is their own"
								: needs(op.needs).map(code).join(" or "),
					],
					[
						"Effect",
						op.effect === "service" ? "runs jobs on the job service" : op.effect === "write" ? "writes" : "reads",
					],
					["Agent tool", op.mcp === null ? "no" : "yes"],
				],
			),
			...(inputs.length > 0
				? [
						"",
						"<details>",
						`<summary>Input of <code>${op.name}</code></summary>`,
						"",
						"| Property | Type | Required | Description |",
						"| --- | --- | --- | --- |",
						...inputs,
						"",
						"</details>",
					]
				: []),
		].join("\n");
	}).join("\n\n");
}

function agentTools(): string {
	return table(
		["Tool", "What the agent is told it is for"],
		MCP_OPS.map((op) => [code(op.name), op.mcp ?? ""]),
	);
}

/** The first paragraph of a page: what it is for. */
export function leadOf(markdown: string): string {
	const [, ...rest] = markdown.split(/^# .*$/m);
	const paragraph =
		rest
			.join("")
			.trim()
			.split(/\n\s*\n/)[0] ?? "";
	return paragraph.replace(/\s+/g, " ").trim();
}

function pages(read: (slug: DocSlug) => string): string {
	return DOC_SECTIONS.map((section) =>
		[
			`### ${section.title}`,
			"",
			...section.pages
				.filter((page) => page.slug !== "index")
				.map((page) => `- [${page.title}](./${page.slug}.md). ${leadOf(read(page.slug))}`),
		].join("\n"),
	).join("\n\n");
}

const readPage = (slug: string): string => readFileSync(new URL(`${slug}.md`, GUIDE), "utf8");

/** Every generated table, by the name in its marker. */
export function generatedBlocks(read: (slug: DocSlug) => string = readPage): Record<string, string> {
	return {
		pages: pages(read),
		"answer-keys": answerKeys(),
		"queue-keys": queueKeys(),
		"policy-presets": policyPresets(),
		capabilities: capabilities(),
		"cli-commands": cliCommands(),
		operations: operations(),
		"agent-tools": agentTools(),
	};
}

const BLOCK = /<!-- generated:([a-z-]+) -->[\s\S]*?<!-- \/generated -->/g;

/** The names of the generated tables a page holds. */
export const blocksIn = (markdown: string): string[] => [...markdown.matchAll(BLOCK)].map((match) => match[1] ?? "");

/**
 * A page with each of its generated tables written again. The blank lines inside the markers are part of the
 * format: without them the closing marker is read as a row of the table above it.
 */
export function applyBlocks(markdown: string, blocks: Record<string, string>): string {
	return markdown.replace(BLOCK, (_all, name: string) => {
		const body = blocks[name];
		if (body === undefined) throw new Error(`no generated table is named ${name}`);
		return `<!-- generated:${name} -->\n\n${body}\n\n<!-- /generated -->`;
	});
}

export const guideFiles = (): string[] =>
	readdirSync(GUIDE)
		.filter((file) => file.endsWith(".md"))
		.sort();

if (import.meta.main) {
	const blocks = generatedBlocks();
	for (const file of guideFiles()) {
		const url = new URL(file, GUIDE);
		const before = await Bun.file(url).text();
		const after = applyBlocks(before, blocks);
		if (after !== before) {
			await Bun.write(url, after);
			console.info(`wrote ${file}`);
		}
	}
}
