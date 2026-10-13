import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import { seed } from "../seed.ts";
import type { AdapterCommand } from "./types.ts";

export const seedCommand: AdapterCommand = {
	name: "seed",
	summary: "Fill a new or empty project with demo data: a shop's cases, results, a run and questions to answer.",
	usage: "seed <project> [--cases 2000] [--json]",
	flags: [{ name: "cases", kind: "number", description: "How many cases to write. Defaults to 2000." }],
	async run(args, client) {
		assertPositionals(args, 1, 1, seedCommand.usage);
		// The project is typed out each time. Read from MAINWORTHY_PROJECT, it would be the one a pipeline reports to.
		if (args.has("project"))
			throw new CliError("invalid", `seed takes the project as its argument: mainworthy ${seedCommand.usage}`);
		const project = args.positionals[0] ?? "";
		const seeded = await seed(client, { project, cases: args.number("cases") ?? 2000 });
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
