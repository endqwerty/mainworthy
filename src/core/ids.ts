import type { StepId } from "./model.ts";

const letters = "abcdefghijklmnopqrstuvwxyz";
const radix = 36;

/** Returns an unused, letter-leading 2–4 character id. Throws only when that finite namespace is exhausted. */
export function newStepId(taken: ReadonlySet<string>, random: () => number = Math.random): StepId {
	for (let length = 2; length <= 4; length++) {
		const suffixes = radix ** (length - 1);
		const capacity = letters.length * suffixes;
		const sample = random();
		const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON) : 0;
		const start = Math.floor(unit * capacity);
		for (let offset = 0; offset < capacity; offset++) {
			const index = (start + offset) % capacity;
			const id =
				letters.charAt(Math.floor(index / suffixes)) + (index % suffixes).toString(radix).padStart(length - 1, "0");
			if (!taken.has(id)) return id;
		}
	}
	throw new RangeError("All letter-leading 2–4 character step ids are taken");
}
