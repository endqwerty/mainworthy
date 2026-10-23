# 0154: Failure subjects are tagged at the storage boundary

Date: 2026-10-22. Implements [issue #392](https://github.com/endqwerty/mainworthy/issues/392).

## Problem

The public `failure` kind represents an ordinary cause, automatic inherited results, or a slot dispute.
Decisions 0042 and 0078 give them different effects and holds, but handlers repeatedly read optional JSON fields.
Those casts let a caller confuse a person's cause answer with a rule's inherited standing.

## Usage

Every question reader, including the partial `openQuestionsOn` projection, returns a parsed failure subject.
Handlers narrow `question.kind` to `failure`, then switch on `question.subject.kind`.
Only the `slot` variant carries a slot ID. Every variant carries its signature and scope.

```ts
switch (question.subject.kind) {
	case "cause":
		// Apply ordinary cause standing and holds.
		break;
	case "inherited":
		// Apply exact-result standing and base-evidence holds.
		break;
	case "slot":
		// Apply standing to question.subject.slot and its named results.
		break;
}
```

## Shape

`questions.ts` owns the storage schema, parser and encoder. SQL reads return private stored row types.
Its public row type correlates `kind: "failure"` with the parsed subject union:

```ts
type FailureSubject =
	| { kind: "cause"; signature: number; scope: string }
	| { kind: "inherited"; signature: number; scope: string }
	| { kind: "slot"; signature: number; scope: string; slot: number };
```

Strict schemas derive this type from the three existing JSON shapes.
They reject missing fields, extra keys, incorrect field types, and subjects containing both `slot` and `perResult`.
`perResult` is accepted only as literal `true`. It becomes the internal `inherited` tag.
Other question kinds retain their existing representation.

New failure questions use the tagged subject. The encoder writes the same legacy fields in their existing order:
`{signature,scope}`, `{signature,scope,perResult:true}`, or `{slot,signature,scope}`.
Reading changes no stored bytes. No migration, API field, operation, answer, witness writer, or ledger changes.
`core/kinds.ts` already selects answers from policy facts and needs no subject representation.

`replaceInheritedSteps` accepts an inherited question and preserves the existing savepoint.
It withdraws the rule answer, finds the ordinary cause, and answers that cause through the shared decision path.
A refusal rolls back both steps. A person's ordinary `inherited` answer keeps its target-limited cause holds.

## Synthesis decision

Independent sketches compared replacing the returned subject with attaching a second parsed field beside the JSON string.
Replacement hides storage details inside the existing readers and prevents consumers from copying the old casts.
The attached-field alternative leaves two ways to interpret a failure subject and needs another rule to prevent bypasses.
Parsing other question kinds at the same time was rejected because it would widen the validation change.

Principles: Type System Discipline selects tagged variants with distinct payloads.
Boundary Discipline puts parsing in the storage readers. Model the Domain names the inherited-to-cause transition.
Subtract Before You Add removes repeated failure JSON parsing without a cache or a parallel raw field.

## Validation boundary

`test/failure-subjects.test.ts` checks the exact variant types, every storage reader, malformed combinations,
and preservation of legacy JSON bytes. Existing evidence, inheritance, integrity, policy and sequence tests
continue to check effects, authorization, withdrawal, replacement rollback and holds.
Malformed stored subjects now fail when read instead of reaching decision code through unchecked casts.
They are outside the valid legacy shapes. No live database inspection or repair is part of this refactor.
The integrating coordinator runs the full check, refreshes test timings and obtains independent verification.
