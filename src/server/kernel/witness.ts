// Proof that a decision was made. Every writer of standing (the current version of a case, a test's link to a
// case, an excuse, a closed run, the policy, a merge receipt) takes a Witness, and only the decision machinery can make one, so
// there is no code path that changes standing without a row in the ledger (principle P0).
//
// What holds it, none of it a naming convention:
// - the type: the class has private fields, so an object literal does not type-check as a Witness;
// - the constructor: it needs a key that never leaves this module, so `new Witness(...)` and
//   `Reflect.construct(Witness, ...)` from anywhere else throw (TypeScript's `private` is not a guard at run time);
// - the value: a writer reads the decision through `decisionOf`, which refuses anything the constructor did not
//   make and any witness of another kind, so a sign-off's witness cannot link a test or excuse a failure;
// - the fields: private and without setters, so a witness cannot be altered after it is made;
// - the mint: `claimMint` hands the one minting function to its first caller and throws for any other, so a
//   second module that tries to mint stops the process when it loads.
// And the database refuses standing that cites a decision the ledger does not hold (foreign keys in the schema).
import type { Kind } from "../../core/kinds.ts";

/** Receipt decisions have their own ledger and no public question or policy clause. */
type WitnessKind = Kind | "merge-receipt";

/** Known only inside this module. The constructor refuses any call that does not present it. */
const KEY: unique symbol = Symbol("witness");

export class Witness {
	readonly #decision: number;
	readonly #kind: WitnessKind;
	readonly #signers: readonly number[];
	readonly #expiresAt: number | null;

	private constructor(
		key: typeof KEY,
		decision: number,
		kind: WitnessKind,
		signers: readonly number[],
		expiresAt: number | null,
	) {
		if (key !== KEY) throw new Error("a witness can only be made by the decision machinery");
		this.#decision = decision;
		this.#kind = kind;
		this.#signers = Object.freeze([...signers]);
		this.#expiresAt = expiresAt;
	}

	/** Actor ids of those whose answers made the decision. For a rule: the rule actor. */
	get signers(): readonly number[] {
		return this.#signers;
	}

	/** When the decision stops holding by the clock, if it does. Standing that expires is stored with it. */
	get expiresAt(): number | null {
		return this.#expiresAt;
	}

	/** @internal See `decisionOf`. */
	static decisionOf(value: Witness, kind: WitnessKind): number {
		if (typeof value !== "object" || value === null || !(#decision in value))
			throw new Error("standing can only be changed by a decision: this is not a witness");
		if (value.#kind !== kind)
			throw new Error(`a ${value.#kind} decision cannot change what only a ${kind} decision may`);
		return value.#decision;
	}

	static #claimed = false;

	/** @internal See `claimMint`. */
	static claim(): Mint {
		if (Witness.#claimed) throw new Error("the witness mint is already held by the decision machinery");
		Witness.#claimed = true;
		return (decision, kind, signers, expiresAt) => new Witness(KEY, decision, kind, signers, expiresAt);
	}
}

export type Mint = (
	decision: number,
	kind: WitnessKind,
	signers: readonly number[],
	expiresAt: number | null,
) => Witness;

/**
 * The one mint. `decisions/decisions.ts` claims it when it loads; a second claim throws. `settle` and `recordMergeReceipt` there mint only after writing
 * their decision row, in the question ledger or the internal receipt ledger respectively.
 */
export const claimMint = (): Mint => Witness.claim();

/**
 * The decision a witness proves, for a writer of standing that only a decision of `kind` may change. Every such
 * writer stores this id and nothing it was handed directly. It throws for anything that is not a minted witness
 * and for a witness of another kind.
 */
export const decisionOf = (witness: Witness, kind: WitnessKind): number => Witness.decisionOf(witness, kind);
