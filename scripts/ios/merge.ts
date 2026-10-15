// The phone runs the same three-way merge as the web app and server, in JavaScriptCore.
import { mergeBodies } from "../../src/core/merge3.ts";
import type { CaseBody } from "../../src/core/model.ts";

// All three documents were decoded through the generated contract before this synchronous call.
type Input = { base: CaseBody; mine: CaseBody; theirs: CaseBody };
Object.assign(globalThis, {
	mergeCase: (input: string): string => JSON.stringify(mergeBodies(JSON.parse(input) as Input)),
});
