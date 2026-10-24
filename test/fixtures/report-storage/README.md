# SQLite report storage reference

`sqlite-main.json` was produced from `origin/main` at
`0f3105e7ec0f9ed1a2de9fd48aa919984d55b9fd`, using its SQLite harness and per-result
report writer. The PostgreSQL test runs the same `snapshots(true)` scenario from
`bench/report-siblings-equivalence.ts`. Both policy presets retain all columns
of each selected table, including results, result_tries, findings, excuses and
all four assertion tables. The scenario also writes attachments, model,
failure step, trail, note, corrections and cross-batch assertion spreading.

The only normalization is `result_excuses.id`. This unreferenced surrogate is
numbered in stored order because PostgreSQL consumes identity values for
conflicting inserts. No column of results, result_tries, findings, excuses or
assertion tables is normalized. Receipt JSON is parsed for structural equality.

To reproduce from this branch, in a scratch directory created by
`bun scripts/work.ts scratch new report-reference`:

```sh
reference='<directory printed by scratch new>'
git archive 0f3105e7ec0f9ed1a2de9fd48aa919984d55b9fd | tar -x -C "$reference"
ln -s "$PWD/node_modules" "$reference/node_modules"
cp bench/report-siblings-equivalence.ts "$reference/bench/report-siblings-equivalence.ts"
python3 - "$reference" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
p = root / 'bench/report-siblings-equivalence.ts'
s = p.read_text().replace(
    'return await h.app.database.read(async (db) => {',
    'return await (async () => {\n\t\tconst db = h.app.db;',
).replace('\n\t});\n}\n\nif (import.meta.main)', '\n\t})();\n}\n\nif (import.meta.main)')
p.write_text(s)
(root / 'test/capture-storage.test.ts').write_text('''
import { test } from "bun:test";
import { snapshots } from "../bench/report-siblings-equivalence.ts";
test("capture SQLite per-result storage", async () => {
    await Bun.write("sqlite-report-storage.json", JSON.stringify(await snapshots(true), null, 2) + "\\n");
});
''')
PY
(cd "$reference" && bun test test/capture-storage.test.ts)
cp "$reference/sqlite-report-storage.json" test/fixtures/report-storage/sqlite-main.json
bunx biome format --write test/fixtures/report-storage/sqlite-main.json
bun scripts/work.ts scratch rm "$reference"
```

The adapter changes only the storage reader from PostgreSQL's read callback to
the SQLite harness's `app.db`. The report inputs and operation calls are copied
unchanged. No PostgreSQL output is used to produce the reference.
