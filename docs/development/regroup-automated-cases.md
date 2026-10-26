# Regroup this repository's existing Automated cases

Run this one-off as the owner after [issue #457](https://github.com/endqwerty/mainworthy/issues/457)
has landed and deployed. It uses only the registered `find`, `get`, and `propose`
operations. No database access or policy change is needed.

1. Use the landed source checkout. Set `MAINWORTHY_URL=https://mainworthy.com`,
   `MAINWORTHY_PROJECT=mainworthy`, and `MAINWORTHY_TOKEN_FILE` to your private token
   file. Leave `MAINWORTHY_TOKEN` unset when using a token file.
2. Pause suite editing until submission and any pending approval finish.
   A placement has no atomic source-folder precondition. The script rechecks the
   preview, but cannot protect a move made between that read and adoption.
3. Run `bun scripts/work.ts scratch new regroup-automated`.
   Save the script below as `regroup.js` in the directory it prints.
4. From the repository root, run
   `bun /absolute/scratch/regroup.js preview /absolute/scratch`.
   Review `plan.json`, which lists each case and its destination.
5. Run the same command with `apply` instead of `preview`.
   Keep `request.json` and `receipt.json`. If the response is lost, use `send`
   to retry the saved request with the same command ID. Do not create a new plan
   for an uncertain request.
6. If the receipt says the proposal is open, accept its question in Queue while
   editing remains paused. An agent token with `read,produce` can submit the
   proposal; under `standard`, a person adopts it. Do not use the owner token as
   an agent or change policy to avoid that approval.
7. Inspect Suite and read back several cases with `get`. Repeat
   `mainworthy find --json '{"in":"cases","folder":"Automated","deep":false,"state":"active","limit":500}'`
   and follow its cursor. Record moved and skipped counts and the proposal in the
   issue. Keep the receipts before removing scratch with
   `bun scripts/work.ts scratch rm /absolute/scratch`.

The preview reads every page before moving anything. It selects active cases
still directly in `Automated`, skips fragments and cases with missing or
conflicting linked file paths, and groups the rest by the landed folder rule.
Cases already moved by a person are outside that selection. Archived cases stay
where they are. A changed case aborts `apply`; inspect it and create a fresh plan
in a new scratch directory. Saved placement inverses in the receipt can restore
old folders, but review them before using them after later edits.

Save this script outside the checkout. It imports the landed derivation and
sends placement proposals through the normal CLI and policy.

```js
import { resolve } from "node:path";
const { folderFor } = await import(`${process.cwd()}/src/server/decisions/kinds.ts`);
const [mode, dir] = Bun.argv.slice(2);
if (!dir || !["preview", "apply", "send"].includes(mode ?? "")) throw Error("preview|apply|send <scratch-dir>");
const target = { url: process.env.MAINWORTHY_URL, project: process.env.MAINWORTHY_PROJECT };
if (!target.url || !target.project) throw Error("Set MAINWORTHY_URL and MAINWORTHY_PROJECT");
const file = (name) => Bun.file(resolve(dir, `${name}.json`));
const call = (op, input) => {
  const result = Bun.spawnSync(["bun", "src/cli/main.ts", op, "--json", JSON.stringify(input)], { stderr: "inherit" });
  if (result.exitCode !== 0) throw Error(`${op} failed; keep saved files`);
  return JSON.parse(result.stdout.toString());
};
const read = (refs) => call("get", { refs, fields: ["place", "tests"] });
const send = async () => {
  const request = await file("request").json();
  const result = call("propose", request);
  await Bun.write(file("receipt"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
};
if (mode === "preview") {
  const refs = [];
  let cursor = null;
  do {
    const page = call("find", { in: "cases", folder: "Automated", deep: false, state: "active", limit: 500,
      ...(cursor ? { cursor } : {}) });
    refs.push(...page.items.map((row) => row.ref));
    cursor = page.cursor;
  } while (cursor);
  const cases = [];
  for (let start = 0; start < refs.length; start += 200) {
    for (const row of read(refs.slice(start, start + 200))) {
      if (row.kind !== "case" || row.state !== "active" || row.folder.path !== "Automated") continue;
      const tests = row.tests ?? [];
      const folders = new Set(tests.filter((test) => test.file).map((test) => folderFor(test.file)));
      if (!tests.length || tests.some((test) => !test.file) || folders.size !== 1 || folders.has("Automated")) {
        console.log(`Skip ${row.ref}: missing or ambiguous destination`); continue;
      }
      cases.push({ ref: row.ref, etag: row.etag, destination: [...folders][0] });
    }
  }
  await Bun.write(file("plan"), JSON.stringify({ target, cases }, null, 2));
  console.log(`Preview: ${cases.length} cases; inspect plan.json`);
} else {
  const plan = await file("plan").json();
  if (JSON.stringify(plan.target) !== JSON.stringify(target)) throw Error("URL/project changed");
  if (mode === "send") await send();
  else {
    if (await file("request").exists()) throw Error("Request exists; inspect receipt or use send to retry");
    const groups = new Map();
    for (let start = 0; start < plan.cases.length; start += 200) {
      const batch = plan.cases.slice(start, start + 200);
      const current = new Map(read(batch.map((row) => row.ref)).map((row) => [row.ref, row.etag]));
      for (const row of batch) {
        if (current.get(row.ref) !== row.etag) throw Error(`${row.ref} changed; make a fresh preview`);
        groups.set(row.destination, [...(groups.get(row.destination) ?? []), row.ref]);
      }
    }
    if (!groups.size) throw Error("No moves selected");
    const edits = [...groups].map(([folder, cases]) => ({ op: "place", cases, folder }));
    await Bun.write(file("request"), JSON.stringify({ cmd: crypto.randomUUID(), reason: "Organize existing auto-created cases by test file (#457)", edits }, null, 2));
    await send();
  }
}```
