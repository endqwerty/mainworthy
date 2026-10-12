// Proof that a decision was made. Every writer of standing (the current version of a case, a test's link to a
// case, an excuse, a closed run, the policy) takes a Witness, and only the decision machinery can make one, so
// there is no code path that changes standing without a row in the ledger (principle P0).
//
// Three things hold it, none of them a naming convention:
// - the type: the class has a private field, so an object literal does not type-check as a Witness;
// - the value: a writer reads the decision through `decisionOf`, which refuses anything `mint` did not make;
// - the mint: `claimMint` hands the one minting function to its first caller and throws for any other, so a
//   second module that tries to mint stops the process when it loads.
// And the database refuses standing that cites a decision the ledger does not hold (foreign keys in the schema).
import type { Kind } from "../../core/kinds.ts";

export class Witness {
	readonly #decision: number;
	readonly kind: Kind;
	/** Actor ids of those whose answers made the decision. For a rule: the rule actor. */
	readonly signers: readonly number[];
	/** When the decision stops holding by the clock, if it does. Standing that expires is stored with it. */
	readonly expiresAt: number | null;

	private constructor(decision: number, kind: Kind, signers: readonly number[], expiresAt: number | null) {
		this.#decision = decision;
		this.kind = kind;
		this.signers = signers;
		this.expiresAt = expiresAt;
	}

	/** The id of the decision row, or an error for a value that is not a minted witness. */
	static decisionOf(value: Witness): number {
		if (typeof value !== "object" || value === null || !(#decision in value))
			throw new Error("standing can only be changed by a decision: this is not a witness");
		return value.#decision;
	}

	static #claimed = false;

	/** @internal See `claimMint`. */
	static claim(): Mint {
		if (Witness.#claimed) throw new Error("the witness mint is already held by the decision machinery");
		Witness.#claimed = true;
		return (decision, kind, signers, expiresAt) => new Witness(decision, kind, signers, expiresAt);
	}
}

export type Mint = (decision: number, kind: Kind, signers: readonly number[], expiresAt: number | null) => Witness;

/**
 * The one mint. `decisions/decisions.ts` claims it when it loads; a second claim throws. `settle` there is its
 * only caller, right after it has written the decision row.
 */
export const claimMint = (): Mint => Witness.claim();

/** The decision a witness proves. Every standing writer stores this and nothing it was handed directly. */
export const decisionOf = (witness: Witness): number => Witness.decisionOf(witness);
