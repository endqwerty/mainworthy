// Authentication limits (the sign-in design, decision 11 as amended, and anonymous starts, decision 0140). Pure: no I/O and no clock of
// its own, so every call that depends on the time is given it. It counts opaque string keys and knows nothing of
// requests, tokens or rows; only the helpers at the end, which make the keys, know what a token looks like and
// which addresses are counted. How an address is written is `kernel/address.ts`'s to say.
//
// It is in memory because a failed attempt must cost nothing: one that queued at the write gate would let a
// flood of wrong guesses stall every writer. One process serves an instance, so memory is the whole state, and a
// restart forgets it.
//
// The rule, for each key on its own:
//   - A failure counts for 15 minutes. Four failures inside 15 minutes cost nothing.
//   - The fifth inside 15 minutes blocks the key for 1 second.
//   - From then on every failure doubles the block, whether the last one was still running or had ended:
//     2 s, 4 s, ... 512 s, and 15 minutes at most.
//   - A key is forgotten 15 minutes after its last failure, or 15 minutes after its block ended when that is
//     later. Until then it keeps the length of its block, so the next failure doubles it again.
//   - A success clears the keys the caller names, at once.
//
// How a surface uses it, here `admit` with a bearer token, where `limiter` is the one its `App` holds. A session
// cookie is never counted, so it never comes this way.
//
//   const address = addressKey(facts.address); // null: unknown, or a proxy's own address, which is never counted
//   const prefix = prefixKey(secret); // null: a secret with nothing to tell it from another
//   const keys = [address, prefix].filter((key) => key !== null);
//   const answer = limiter.check(keys, app.now());
//   if (answer.kind === "blocked") {
//     // A secret outside the generated format is not looked at. One in it is, and passes when it is right and
//     // the server made it: the owner's token from the environment is a person's choice whatever it looks like.
//     const token = isGeneratedSecret(secret) ? findToken(app.db, hashToken(secret)) : null;
//     return token && !token.chosen ? admitted(token) : limited(answer.retryAfterSeconds); // nothing is reported
//   }
//   const token = findToken(app.db, hashToken(secret));
//   if (!token) {
//     limiter.failed(keys, app.now());
//     return unauthorized();
//   }
//   if (prefix !== null) limiter.succeeded([prefix]); // never the address key
//   return admitted(token);
//
// What the caller keeps to in those lines:
//   - `check` comes before the secret is looked at. It is a question and not an attempt: asking changes nothing,
//     however often.
//   - While a key is blocked, only a secret in the generated format is looked up, and a right one the server
//     made passes. Nobody guesses 190 bits, and refusing a right one would let anyone who shares an address
//     with a pipeline stop it. A secret a person chose gets no pass: a right guess at one is what the block is
//     there to prevent. The format does not say who chose a secret (`isGeneratedSecret`), so the caller asks
//     the token's row: one whose value came from the environment gets no pass in any format.
//   - Nothing is reported for a request that came during a block. Not a failure, so asking again and again does
//     not lengthen the block; and not a success, so the holder of a token does not clear the count of whoever
//     is guessing at it.
//   - `failed` is given the keys `check` was asked about, all of them.
//   - `succeeded` is given the prefix key (for a password, the account key: `accountKey`), never the address key: one valid token of
//     little standing, used between guesses, would otherwise reset the count of the address that is guessing.
//
// A sign-in that verifies a password does the same around its `await`, and reads the clock again after it. A
// password is a secret a person chose, so a blocked sign-in is refused without verifying it.
//
// Where `facts.address` comes from, on the HTTP surface (`clientAddress` in `surfaces/http.ts`): the peer's own
// address, unless the peer is a proxy the operator named, whose header is then read. The list is parsed once,
// where the configuration is read (`defaultConfig`), and a `malformed` answer stops the start with the entry it
// names. `parseAddressRanges` and `headerAddress` are in `kernel/address.ts`.
//
//   const address = proxy?.peers.contains(peer) ? headerAddress(request.headers.get(proxy.header)) : peer;

import { ADDRESS_LENGTH, inPrivateRange, parseAddress } from "../kernel/address.ts";

const SECOND_MS = 1000;
/** How long a failure counts, and how long a key is remembered after its last failure or its block. */
const WINDOW_MS = 15 * 60 * SECOND_MS;
/** Failures inside the window that cost nothing; the next one blocks. */
const FREE_FAILURES = 4;
const FIRST_BLOCK_MS = SECOND_MS;
const LONGEST_BLOCK_MS = 15 * 60 * SECOND_MS;
const DEFAULT_MAX_KEYS = 10_000;

export type LimiterAnswer =
	| { readonly kind: "free" }
	/** `retryAfterSeconds` is a whole number, at least 1: the value of a `Retry-After` header. */
	| { readonly kind: "blocked"; readonly retryAfterSeconds: number };

export type Limiter = {
	/**
	 * May an attempt that counts against these keys be made now? Blocked when any of them is, with the seconds,
	 * rounded up, until the first moment all of them are free. Changes nothing, however often it is asked.
	 */
	check: (keys: readonly string[], now: number) => LimiterAnswer;
	/** An attempt was looked at and was wrong: one failure for each of these keys. A key named twice counts once. */
	failed: (keys: readonly string[], now: number) => void;
	/** An attempt was right: forget these keys, except blocks newer than the supplied version. */
	succeeded: (keys: readonly string[], blockVersion?: number) => void;
	/** The newest block's version. A slow success may clear only blocks no newer than when its check began. */
	readonly blockVersion: number;
	/** The keys held, those not yet dropped after their time included. This is the number the bound is on. */
	readonly size: number;
};

/** What is remembered about one key. `lastFailure` is the time of its newest failure. */
type Entry =
	/** Fewer than five failures inside the window: `recent` is their times, oldest first. */
	| { readonly kind: "counting"; readonly lastFailure: number; readonly recent: readonly number[] }
	/** The fifth failure or a later one: a block of `blockMs`, from `lastFailure` to `until`. */
	| {
			readonly kind: "tripped";
			readonly lastFailure: number;
			readonly blockMs: number;
			readonly until: number;
			readonly blockVersion: number;
	  };

const FREE: LimiterAnswer = { kind: "free" };

/**
 * Anonymous ceremony allocation has a separate fixed window, not a wrong-credential penalty. Three hundred
 * starts per source per minute permits an office's burst. Refusals do not extend the window or escalate.
 * There is no shared allowance for another source to exhaust.
 */
export function createStartLimiter(): (key: string | null, now: number) => LimiterAnswer {
	const windowMs = 60_000;
	const starts = 300;
	type Window = { since: number; count: number };
	const entries = new Map<string, Window>();
	const active = (window: Window | undefined, now: number): Window | undefined =>
		window && now >= window.since && now < window.since + windowMs ? window : undefined;
	const wait = (window: Window | undefined, allowance: number, now: number): number =>
		window && window.count >= allowance ? window.since + windowMs - now : 0;
	return (key, now) => {
		const entry = active(key === null ? undefined : entries.get(key), now);
		const left = wait(entry, starts, now);
		if (left > 0) return { kind: "blocked", retryAfterSeconds: Math.ceil(left / 1000) };
		if (key === null) return FREE;
		if (entry) {
			entry.count++;
		} else {
			entries.delete(key);
			if (entries.size >= DEFAULT_MAX_KEYS) {
				for (const [held, window] of entries) if (now >= window.since + windowMs) entries.delete(held);
				const oldest = entries.keys().next();
				if (entries.size >= DEFAULT_MAX_KEYS && !oldest.done) entries.delete(oldest.value);
			}
			entries.set(key, { since: now, count: 1 });
		}
		return FREE;
	};
}

/** The moment a key is forgotten when no further failure comes. */
const forgottenAt = (entry: Entry): number => (entry.kind === "counting" ? entry.lastFailure : entry.until) + WINDOW_MS;

/** The milliseconds a key is still blocked for; 0 when it is free. */
function blockLeft(entry: Entry | undefined, now: number): number {
	if (entry?.kind !== "tripped") return 0;
	// A block holds only between the failure that set it and its end. With the upper limit alone, a clock that
	// was set back an hour would turn a block of one second into a block of an hour.
	return now >= entry.lastFailure && now < entry.until ? entry.until - now : 0;
}

/** What a key is after one more failure. `entry` is undefined for a key that is unknown or forgotten. */
function afterFailure(entry: Entry | undefined, now: number, blockVersion: number): Entry {
	if (entry?.kind === "tripped") {
		const blockMs = Math.min(entry.blockMs * 2, LONGEST_BLOCK_MS);
		return { kind: "tripped", lastFailure: now, blockMs, until: now + blockMs, blockVersion };
	}
	const recent = [...(entry?.recent ?? []).filter((at) => at > now - WINDOW_MS), now];
	if (recent.length <= FREE_FAILURES) return { kind: "counting", lastFailure: now, recent };
	return { kind: "tripped", lastFailure: now, blockMs: FIRST_BLOCK_MS, until: now + FIRST_BLOCK_MS, blockVersion };
}

/**
 * A limiter with nothing in it. The caller holds it: there is one for each `App`, so two instances in one
 * process, as in the tests, do not count each other's failures.
 *
 * `maxKeys` bounds the memory: when a failure brings a new key and the limiter is full, the keys whose time has
 * passed are dropped, and if it is still full the key with the oldest last failure is dropped.
 *
 * What that costs: whoever can fail with `maxKeys` distinct keys after some key's last failure makes the
 * limiter forget that key, and so buys its four free failures again. By default that is 10,000 requests for
 * five guesses, where no limit at all would give 10,000 guesses. A sender whose address is counted is blocked
 * after its own fifth failure, so this takes thousands of IPv4 addresses or IPv6 networks, or a place behind a
 * proxy whose address is not counted. It is accepted because every other answer to a full limiter is worse:
 * growing lets an anonymous flood take the process's memory, and refusing new keys lets the same flood switch
 * the limit off for whoever comes after it.
 */
export function createLimiter(options: { maxKeys?: number } = {}): Limiter {
	const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
	// A bound of zero would be a limiter that counts nothing and says so nowhere.
	if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new RangeError("maxKeys must be a whole number above 0");

	// In the order of last failures, oldest first: `failed` takes a key out and puts it back at the end. That
	// order lets `makeRoom` look only at the keys whose last failure is older than the window, so a flood of new
	// keys does not cost each of them a pass over every key. A clock that was set back can put the times out of
	// this order; room is still made then, by dropping the key whose failure was reported longest ago.
	const entries = new Map<string, Entry>();
	let blockVersion = 0;

	const remembered = (key: string, now: number): Entry | undefined => {
		const entry = entries.get(key);
		return entry && forgottenAt(entry) > now ? entry : undefined;
	};

	const makeRoom = (now: number): void => {
		for (const [key, entry] of entries) {
			// A key is remembered for at least the window after its last failure, so from the first key that
			// failed inside the window onward, none has run out of time.
			if (entry.lastFailure + WINDOW_MS > now) break;
			if (forgottenAt(entry) <= now) entries.delete(key);
		}
		if (entries.size < maxKeys) return;
		const oldest = entries.keys().next();
		if (!oldest.done) entries.delete(oldest.value);
	};

	return {
		check: (keys, now) => {
			let left = 0;
			for (const key of keys) left = Math.max(left, blockLeft(entries.get(key), now));
			return left === 0 ? FREE : { kind: "blocked", retryAfterSeconds: Math.ceil(left / SECOND_MS) };
		},
		failed: (keys, now) => {
			for (const key of new Set(keys)) {
				const next = afterFailure(remembered(key, now), now, blockVersion + 1);
				if (next.kind === "tripped") blockVersion = next.blockVersion;
				if (!entries.delete(key) && entries.size >= maxKeys) makeRoom(now);
				entries.set(key, next);
			}
		},
		succeeded: (keys, observedVersion = blockVersion) => {
			for (const key of keys) {
				const entry = entries.get(key);
				if (entry?.kind !== "tripped" || entry.blockVersion <= observedVersion) entries.delete(key);
			}
		},
		get blockVersion() {
			return blockVersion;
		},
		get size() {
			return entries.size;
		},
	};
}

const TOKEN_MARKER = "cb_";
const PREFIX_LENGTH = 8;
const GENERATED_SECRET = /^cb_[0-9a-zA-Z]{32}$/;

/**
 * The key a presented secret is counted under: its first 8 characters, taken after the `cb_` marker when it has
 * one, because every generated token starts with the marker and those three characters tell no two apart. A
 * secret shorter than 8 characters is its own key. Guesses at one token share a key wherever they come from,
 * and no more than 8 characters of anything a stranger sends are kept.
 *
 * Null for an empty secret and for the marker alone. Their key would be the same empty one for everybody who
 * sends nothing, and one sender's failures would block all the others.
 */
export function prefixKey(secret: string): string | null {
	const body = secret.startsWith(TOKEN_MARKER) ? secret.slice(TOKEN_MARKER.length) : secret;
	return body === "" ? null : `prefix:${body.slice(0, PREFIX_LENGTH)}`;
}

/** The longest account name there is (`createToken` and an invitation refuse a longer one), and so the most a key keeps of one. */
const ACCOUNT_LENGTH = 64;

/**
 * The key a sign-in for an account is counted under: the name that was typed, in lower case and cut to the
 * length of a name, so that what a stranger types does not decide how much memory a key takes. A name that
 * does not exist is counted exactly as one that does: the count must not say which names there are. Guesses at
 * one person's password share this key wherever they come from, as guesses at one token share its prefix.
 *
 * Lower case, because a key is not a lookup: `Robin` and `robin` are two names to the instance and one target
 * to whoever is guessing, and counting them apart would double the guesses.
 *
 * Null for a name that is empty or only spaces: its key would be the same one for everybody who sends nothing.
 */
export function accountKey(name: string): string | null {
	const text = name.trim().toLowerCase();
	return text === "" ? null : `account:${text.slice(0, ACCOUNT_LENGTH)}`;
}

/**
 * Is this secret in the form the server generates: `cb_` and 32 characters of `0-9a-zA-Z`? Such a secret is
 * about 190 random bits, so a right one is not a guess, and the caller lets it pass while its keys are blocked
 * (see the top of this file). It says nothing about whether the secret is right, or was in fact generated.
 */
export function isGeneratedSecret(secret: string): boolean {
	return GENERATED_SECRET.test(secret);
}

/**
 * The key a client's address is counted under, or null when it is not counted: an address that is unknown (null
 * or empty), which would otherwise be one key for every client the server could not place, and one that is
 * loopback or private.
 *
 * An IPv4 address is its own key, however it is written: `::ffff:203.0.113.9` and `203.0.113.9` are the same
 * client. An IPv6 address is keyed by its first 64 bits. That is the network one subscriber is given, and
 * whoever holds it can send from any of its 2^64 addresses, a new one for every guess.
 *
 * Text that is not an address is counted as it stands, cut to the length of an address so that what a stranger
 * can write does not decide how much memory a key takes.
 */
export function addressKey(address: string | null): string | null {
	const text = address?.trim() ?? "";
	if (text === "") return null;
	const parsed = parseAddress(text, true);
	if (parsed === null) return `addr:${text.slice(0, ADDRESS_LENGTH)}`;
	if (inPrivateRange(parsed)) return null;
	if (parsed.kind === "v4") return `addr:${parsed.bytes.join(".")}`;
	const network = parsed.groups.slice(0, 4).map((group) => group.toString(16));
	return `addr:${network.join(":")}::/64`;
}

/** Anonymous starts share an IPv6 subscriber's /56; failed-proof counts keep their existing /64 rule. */
export function startAddressKey(address: string | null): string | null {
	const key = addressKey(address);
	const parsed = address === null ? null : parseAddress(address.trim(), true);
	if (key === null || parsed?.kind !== "v6") return key;
	const [a = 0, b = 0, c = 0, d = 0] = parsed.groups;
	return `addr:${[a, b, c, d & 0xff00].map((group) => group.toString(16)).join(":")}::/56`;
}
