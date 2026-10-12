import { z } from 'zod';

export const number = z.coerce.number().finite();
export const bodySchema = z.object({
  title: z.string(), pre: z.string(),
  steps: z.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() })),
  methods: z.array(z.object({ m: z.enum(['human', 'auto', 'agent']), tests: z.array(number).optional() })),
  intent: z.object({ automate: z.enum(['none', 'wanted', 'not-applicable']) }),
  fields: z.record(z.string(), z.json()),
});
export type CaseBody = z.infer<typeof bodySchema>;
export const getInput = z.object({ ref: z.number().int().positive() });
export const caseRow = z.object({
  id: number, project: number, ref_no: number, folder: number, rank: number,
  title: z.string(), head_no: number, head_hash: z.string(), state: z.string(), rev: number,
});
export const getOutput = caseRow.extend({ body: bodySchema });
export const proposeInput = z.object({
  cmd: z.string().min(1), ref: z.number().int().positive(), body: bodySchema,
  base: z.number().int().positive().optional(),
});
export const proposeOutput = z.object({ caseId: number, version: number, seq: number, hash: z.string() });
export const resultInput = z.object({
  key: z.string(), outcome: z.enum(['pass', 'fail']), durationMs: z.number().int().nonnegative(), message: z.string().optional(),
});
export const reportInput = z.object({
  key: z.string().min(1), commit: z.string().min(1), results: z.array(resultInput).min(1),
});
export const reportOutput = z.object({ batch: number, inserted: number, newTests: number, failures: number, signatures: number, seq: number });
export type ReportInput = z.infer<typeof reportInput>;
export type ProposeInput = z.infer<typeof proposeInput>;
export const folderInput = z.object({ folder: z.number().int().positive(), cursor: z.number().int() });
export const searchInput = z.object({ text: z.string(), area: z.number().int().min(1).max(20).nullable() });
export const testInput = z.object({ test: z.number().int().positive() });
export const gateInput = z.object({ commit: z.string() });
export const countRow = z.object({ n: number });
export const idRow = z.object({ id: number });
export const seqRow = z.object({ seq: number });
export const testRow = z.object({ id: number, key: z.string(), case_id: number.nullable(), head_no: number.nullable() });
export const signatureRow = z.object({ id: number, hash: z.string(), sample: z.string() });
export const questionRow = z.object({
  id: number, project: number, ref_no: number, kind: z.string(), fingerprint: z.string(), epoch: number,
  state: z.string(), owner: number, rank: number, evidence: z.string(), evidence_hash: z.string(), rev: number,
});
export const resultRow = z.object({
  id: number, project: number, test: number, seq: number, ord: number, batch: number, target: number,
  outcome: z.string(), basis: z.string(), basis_case: number.nullable(), basis_version: number.nullable(),
  duration_ms: number.nullable(), signature: number.nullable(), message: z.string().nullable(),
});
export const runRow = z.object({
  id: number, project: number, commit_sha: z.string(), verdict: z.string(), tally: z.string(), outstanding: number,
  next_expiry: number.nullable(), rev: number,
});
