import { z } from 'zod';
import { Workloads } from './workloads';
import { getInput, getOutput, proposeInput, proposeOutput, reportInput, reportOutput } from './schemas';

function operation<I extends z.ZodObject, O extends z.ZodObject>(spec: {
  name: string; description: string; effect: 'read' | 'write'; input: I; output: O;
  run: (ctx: Workloads, input: z.output<I>) => Promise<z.input<O>>;
}) {
  return { ...spec, invoke: async (ctx: Workloads, raw: unknown): Promise<Record<string, unknown>> => spec.output.parse(await spec.run(ctx, spec.input.parse(raw))) };
}
export const registry = [
  operation({ name: 'get', description: 'Read a case and its current immutable version by project reference.', effect: 'read', input: getInput, output: getOutput, run: (ctx, input) => ctx.get(input) }),
  operation({ name: 'propose', description: 'Seal and adopt a case version atomically. Repeating cmd returns the original receipt.', effect: 'write', input: proposeInput, output: proposeOutput, run: (ctx, input) => ctx.propose(input) }),
  operation({ name: 'report', description: 'Ingest a normalized test report atomically. Repeating the batch key inserts nothing.', effect: 'write', input: reportInput, output: reportOutput, run: (ctx, input) => ctx.report(input) }),
];
export const openapi = () => ({
  openapi: '3.1.0', info: { title: 'Mainworthy TS spike', version: '0.1.0' },
  paths: Object.fromEntries(registry.map(op => [`/api/${op.name}`, { post: {
    operationId: op.name, summary: op.description,
    requestBody: { required: true, content: { 'application/json': { schema: { ...z.toJSONSchema(op.input, { target: 'draft-2020-12' }), $id: `urn:mainworthy:${op.name}:input` } } } },
    responses: { '200': { description: 'Operation result', content: { 'application/json': { schema: { ...z.toJSONSchema(op.output, { target: 'draft-2020-12' }), $id: `urn:mainworthy:${op.name}:output` } } } } },
  } }])),
});
export function help(name?: string): string {
  const ops = name ? registry.filter(op => op.name === name) : registry;
  if (!ops.length) throw new Error(`Unknown command ${name}`);
  return ['mainworthy <operation> --json <input> | --file <path>', ...ops.map(op => `${op.name}: ${op.description}\nInput: ${JSON.stringify(z.toJSONSchema(op.input))}`)].join('\n');
}
