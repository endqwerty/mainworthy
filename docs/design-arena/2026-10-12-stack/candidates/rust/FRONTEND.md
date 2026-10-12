# Sharing a TypeScript UI with a Rust service

This is a concrete design example, written after the required spike and registry checks passed. It is not an implemented UI or a measured WASM build.

Generate the wire types from the existing operation registry. The binary's `openapi` command emits the same OpenAPI document as HTTP. For example, [openapi-typescript](https://openapi-ts.dev/introduction) can generate `ui/operations.d.ts` from that document. A typed client then uses `components['schemas']['propose_input']`, so a renamed input field changes the server and the generated client contract together. `methods`, `intent`, and `fields` are JSON values in this spike; the production domain types need to be narrower for the UI to benefit from precise types.

Put the pure document functions and their types in `casebook-core`. It depends on Serde and the parsing/diff code, and has no axum, Tokio, database, clock or filesystem dependency. Both the server and a small `casebook-wasm` crate depend on it. The core owns these functions:

```rust
pub fn parse_markdown(text: &str) -> Result<CaseBody, ParseError>;
pub fn print_markdown(body: &CaseBody) -> String;
pub fn diff_steps(before: &[Step], after: &[Step]) -> Vec<StepChange>;
pub fn split_outline(paste: &str) -> Result<Vec<Step>, ParseError>;
```

One [wasm-bindgen bridge](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/result.html) for paste splitting shows the mechanism. The parser calls the same core function on both sides:

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn split_outline_json(paste: &str) -> Result<String, JsValue> {
	let steps = casebook_core::split_outline(paste)
		.map_err(|e| JsValue::from_str(&e.to_string()))?;
	serde_json::to_string(&steps)
		.map_err(|e| JsValue::from_str(&e.to_string()))
}
```

The UI loads the WASM module once, then calls it locally. This sample uses the generated operation type for the returned steps:

```typescript
import init, { split_outline_json } from './casebook-wasm.js';
import type { components } from './operations';

type Body = components['schemas']['CaseBody'];
await init();
const steps: Body['steps'] = JSON.parse(split_outline_json(pastedText));
```

The Markdown parser/printer and step diff use the same wrapper shape. Return a typed error with location information instead of a string in a real editor. A later [serde-wasm-bindgen bridge](https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/) can return JavaScript objects directly. That avoids the extra JSON serialization and parse, at the cost of another bridge dependency. Neither approach removes the string copy into WASM. Keep capture state and optimistic changes in TypeScript; run parsing on paste or document boundaries, and measure any call used on every keystroke.

A core logic change touches one Rust implementation and its shared fixtures. Check the native crate and browser WASM output against the same canonical round-trip, step-identity and outline-boundary tests. Then rebuild the WASM package and replace its browser asset. It does not require a second implementation in TypeScript.

A contract change touches the DTO and its registry row if the operation changes, then regenerates OpenAPI and `operations.d.ts`. A changed WASM function signature also regenerates the wasm-bindgen declarations. The deploy must pair the server contract, WASM asset and UI type generation, ideally in one versioned container build. Hash the WASM filename to prevent a stale browser asset from using a newer server contract.

The cost per change is therefore one source edit, two build/test targets and generated browser assets/types. Core and wire changes sometimes require a wrapper edit too. The spike measured a native application recompile at 10.28 s, but did not measure this smaller core's native or WASM build, browser startup, bundle size or per-call latency. Those costs need a browser measurement before choosing this route for an editor with a one-frame interaction budget.

The alternative is to make TypeScript own all pure document logic and duplicate or embed it in Rust. Duplication risks parser/diff drift; embedding a JavaScript engine adds another runtime and deployment contract. A Rust core compiled to WASM preserves one implementation and is the route I would test first for this candidate.
