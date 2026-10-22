// The count of failed attempts of one instance: the limiter (`limiter.ts`, which is pure and knows no instance)
// that an `App` holds. A token, a password, a passkey and an invitation are all counted in the same one, so an
// address that is blocked for wrong tokens is blocked for wrong passwords too.
import type { App } from "../kernel/app.ts";
import { createLimiter, createStartLimiter, type Limiter, type LimiterAnswer, startAddressKey } from "./limiter.ts";

// One for each `App`, as `uses.ts` keeps its notes: two instances in one process, as in the tests, do not count
// each other's failures. Nothing clears it but a restart. An import does not: it replaces the tokens and the
// people, not whoever is guessing at them.
const limiters = new WeakMap<App, Limiter>();
const starts = new WeakMap<App, ReturnType<typeof createStartLimiter>>();

/** Anonymous allocation counts never read or alter failed-authentication counts. */
export function takeStart(app: App, address: string | null): LimiterAnswer {
	let limiter = starts.get(app);
	if (!limiter) {
		limiter = createStartLimiter();
		starts.set(app, limiter);
	}
	return limiter(startAddressKey(address), app.now());
}

/** The limiter of this instance, made the first time it is asked for. */
export function limiterOf(app: App): Limiter {
	let limiter = limiters.get(app);
	if (!limiter) {
		limiter = createLimiter();
		limiters.set(app, limiter);
	}
	return limiter;
}
