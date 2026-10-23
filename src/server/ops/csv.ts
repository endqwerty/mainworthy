import { CsvImportInput, mapCsv } from "../../core/csv.ts";
import { contentHash } from "../../core/hash.ts";
import type { Edit } from "../../core/ops.ts";
import { type CsvImportReply, REPLIES } from "../../core/replies.ts";
import { conflict, invalid } from "../kernel/errors.ts";
import { currentPolicy } from "../policy/policy.ts";
import { findCase } from "../suite/suite.ts";
import { defineOp } from "./registry.ts";
import { proposeSteps } from "./writes.ts";

export const csvImportOp = defineOp({
	name: "import-csv",
	summary: "Preview mapped CSV cases, then confirm one import proposal. Existing foreign aliases are refused.",
	input: CsvImportInput,
	output: REPLIES["import-csv"],
	needs: "produce",
	scope: "project",
	effect: "write",
	mcp: null,
	async *steps(ctx, input): AsyncGenerator<undefined, CsvImportReply, void> {
		const policy = await currentPolicy(ctx.db, ctx.project.id);
		let plan: ReturnType<typeof mapCsv>;
		try {
			plan = mapCsv(input.csv, input.mapping, policy.settings.fields ?? {}, input.preset);
		} catch (error) {
			throw invalid(error instanceof Error ? error.message : String(error));
		}
		for (const row of plan.rows) {
			if (row.alias && findCase(ctx.db, ctx.project.id, row.alias)) {
				row.errors.push(`case alias ${row.alias} is already in use`);
				row.body = null;
			}
		}
		const refused = plan.rows.filter((row) => row.errors.length > 0).length;
		const confirmation = refused
			? null
			: contentHash({
					project: ctx.project.id,
					policy: policy.version,
					csv: input.csv,
					mapping: input.mapping ?? null,
					preset: input.preset ?? null,
				});
		const reply: CsvImportReply = {
			...plan,
			create: plan.rows.length - refused,
			refused,
			confirmation,
			proposal: null,
		};
		if (input.confirm === undefined) return reply;
		if (refused)
			throw invalid("CSV contains refused records; fix them and preview again", {
				rows: plan.rows.filter((row) => row.errors.length),
			});
		if (input.confirm !== confirmation)
			throw conflict("CSV, mapping or policy changed; preview again before importing");
		const edits: Edit[] = plan.rows.map((row) => {
			if (!row.body || !row.alias) throw new Error("a validated CSV row has no case body or alias");
			return { op: "create", body: row.body, folder: row.folder, aliases: [row.alias] };
		});
		reply.proposal = yield* proposeSteps(ctx, { edits, reason: "Import mapped CSV" });
		return reply;
	},
});
