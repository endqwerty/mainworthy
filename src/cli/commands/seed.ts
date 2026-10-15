import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import { DEFAULT_SEED, DEFAULT_SEED_CASES, DEFAULT_SEED_DAYS, seed } from "../seed.ts";
import type { AdapterCommand } from "./types.ts";

export const seedCommand: AdapterCommand = {
	name: "seed",
	summary:
		"Fill a new or empty project with demo data: a shop's cases, two weeks of results and runs, and questions to answer.",
	usage: `seed <project> [--cases ${DEFAULT_SEED_CASES}] [--seed ${DEFAULT_SEED}] [--days ${DEFAULT_SEED_DAYS}] [--unlinked-files 60] [--json]`,
	flags: [
		{ name: "cases", kind: "number", description: `How many cases to write. Defaults to ${DEFAULT_SEED_CASES}.` },
		{
			name: "seed",
			kind: "number",
			description: `The number the demo is made from: the same seed gives the same demo. Defaults to ${DEFAULT_SEED}.`,
		},
		{
			name: "days",
			kind: "number",
			description: `How many days of history to write before today, 0 for none. Defaults to ${DEFAULT_SEED_DAYS}.`,
		},
		{
			name: "unlinked-files",
			kind: "number",
			description:
				"How many files of unit tests with no case the pipeline reports: one open question each. Defaults to 60; 0 for none.",
		},
	],
	async run(args, client) {
		assertPositionals(args, 1, 1, seedCommand.usage);
		// The project is typed out each time. Read from MAINWORTHY_PROJECT, it would be the one a pipeline reports to.
		if (args.has("project"))
			throw new CliError("invalid", `seed takes the project as its argument: mainworthy ${seedCommand.usage}`);
		const project = args.positionals[0] ?? "";
		const seedNumber = args.number("seed");
		const days = args.number("days");
		const seeded = await seed(client, {
			project,
			cases: args.number("cases") ?? DEFAULT_SEED_CASES,
			...(seedNumber === undefined ? {} : { seed: seedNumber }),
			...(days === undefined ? {} : { days }),
			unlinkedFiles: args.number("unlinked-files") ?? 60,
		});
		const summary = {
			project,
			cases: seeded.cases.length,
			run: seeded.run,
			proposal: seeded.proposal,
			questions: seeded.questions,
			url: `${client.url}/p/${project}/suite`,
		};
		if (args.has("json")) printJson(summary, args.bool("compact"));
		else {
			line(`seeded ${project}: ${summary.cases} cases, run ${summary.run}, ${summary.questions.length} questions`);
			line(summary.url);
		}
		return 0;
	},
};
