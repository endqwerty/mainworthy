import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { resultInput } from './schemas';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, isArray: name => name === 'testcase' });
const parsedXml = z.object({ testsuite: z.object({ testcase: z.array(z.object({
  classname: z.string(), name: z.string(), time: z.coerce.number(),
  failure: z.union([z.string(), z.object({ '#text': z.string().default('') })]).optional(),
})) }) });
export function parseJUnit(xml: string): z.infer<typeof resultInput>[] {
  const suite = parsedXml.parse(parser.parse(xml));
  return suite.testsuite.testcase.map(test => test.failure === undefined
    ? { key: `${test.classname}::${test.name}`, outcome: 'pass', durationMs: Math.round(test.time * 1000) }
    : { key: `${test.classname}::${test.name}`, outcome: 'fail', durationMs: Math.round(test.time * 1000), message: typeof test.failure === 'string' ? test.failure : test.failure['#text'] });
}
export function generateJUnit(): string {
  return `<testsuite tests="10000" failures="200">${Array.from({ length: 10000 }, (_, i) => `<testcase classname="tests/arena.spec.ts" name="test ${i}" time="0.123">${i < 200 ? `<failure>${`Assertion ${i % 20}: expected the visible result to match the case. `.repeat(7)}</failure>` : ''}</testcase>`).join('')}</testsuite>`;
}
