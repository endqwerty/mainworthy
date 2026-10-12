// Proof that a decision was made. Every writer of standing (the current version of a case, a test's link to a
// case, an excuse, a closed run, the policy) takes a Witness, and only the decision machinery can make one, so
// there is no code path that changes standing without a row in the ledger (principle P0).
import type { Kind } from "../../core/kinds.ts";

const MINT: unique symbol = Symbol("witness");

export class Witness {
	readonly decision: number;
	readonly kind: Kind;
	/** Actor ids of those whose answers made the decision. For a rule: the rule actor. */
	readonly signers: readonly number[];
	/** When the decision stops holding by the clock, if it does. Standing that expires is stored with it. */
	readonly expiresAt: number | null;

	private constructor(
		key: typeof MINT,
		decision: number,
		kind: Kind,
		signers: readonly number[],
		expiresAt: number | null,
	) {
		if (key !== MINT) throw new Error("a witness can only be minted by a decision");
		this.decision = decision;
		this.kind = kind;
		this.signers = signers;
		this.expiresAt = expiresAt;
	}

	/** @internal Imported by `decisions/settle.ts` only; a test fails if any other module imports it. */
	static mint(decision: number, kind: Kind, signers: readonly number[], expiresAt: number | null): Witness {
		return new Witness(MINT, decision, kind, signers, expiresAt);
	}
}

/** @internal The single mint. See the import check in `test/architecture.test.ts`. */
export const mintWitness = Witness.mint;
