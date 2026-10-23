// A CSV preview row, without the import parser and input schemas.
import { z } from "zod";
import { CaseBody } from "./model.ts";

export const CsvImportRow = z.object({
	record: z.number().int().positive(),
	alias: z.string().nullable(),
	folder: z.string(),
	body: CaseBody.nullable(),
	errors: z.array(z.string()),
});
export type CsvImportRow = z.infer<typeof CsvImportRow>;
