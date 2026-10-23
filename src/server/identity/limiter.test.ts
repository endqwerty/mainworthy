import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type Harness, harness } from "../../../test/helpers.ts";
import { isLoopbackOrPrivate } from "../kernel/address.ts";
import { limiterOf } from "./attempts.ts";
import { admit, createToken, hashToken } from "./identity.ts";
import {
	accountKey,
	addressKey,
	createLimiter,
	isGeneratedSecret,
	type LimiterAnswer,
	prefixKey,
	startAddressKey,
} from "./limiter.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const START = Date.UTC(2026, 9, 13, 9, 0);

const FREE: LimiterAnswer = { kind: "free" };
const blocked = (seconds: number): LimiterAnswer => ({ kind: "blocked", retryAfterSeconds: seconds });

test("start keys group a subscriber's /56 without changing failed-proof /64 keys or IPv4 identity", () => {
	expect(startAddressKey("2001:db8:0:100::1")).toBe(startAddressKey("2001:db8:0:1ff::2"));
	expect(startAddressKey("2001:db8:0:100::1")).not.toBe(startAddressKey("2001:db8:0:200::1"));
	expect(addressKey("2001:db8:0:100::1")).not.toBe(addressKey("2001:db8:0:101::1"));
	expect(startAddressKey("::ffff:203.0.113.10")).toBe(startAddressKey("203.0.113.10"));
	expect(startAddressKey("203.0.113.10")).not.toBe(startAddressKey("203.0.113.11"));
	expect(startAddressKey(null)).toBeNull();
	expect(startAddressKey("127.0.0.1")).toBeNull();
});

/** A limiter and the clock it is told. Nothing sleeps: time passes when a test says so. */
function world(options?: { maxKeys?: number }) {
	const limiter = createLimiter(options);
	let now = START;
	return {
		limiter,
		pass: (ms: number): void => {
			now += ms;
		},
		fail: (key: string, times = 1): void => {
			for (let i = 0; i < times; i++) limiter.failed([key], now);
		},
		check: (...keys: string[]): LimiterAnswer => limiter.check(keys, now),
	};
}

describe("the rule", () => {
	test("four failures inside 15 minutes cost nothing, and the fifth blocks the key for 1 second", () => {
		const w = world();
		for (let i = 0; i < 4; i++) {
			w.fail("a");
			expect(w.check("a")).toEqual(FREE);
			w.pass(3 * MINUTE);
		}
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(1));
		w.pass(SECOND - 1);
		expect(w.check("a")).toEqual(blocked(1));
		w.pass(1);
		expect(w.check("a")).toEqual(FREE);
	});

	test("a failure counts for 15 minutes and no longer", () => {
		const w = world();
		w.fail("a", 4);
		w.pass(15 * MINUTE);
		// The four are 15 minutes old: this is a first failure, not a fifth.
		w.fail("a", 4);
		expect(w.check("a")).toEqual(FREE);
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(1));
	});

	test("the 15 minutes end at the newest failure: the count does not start again on a fixed quarter hour", () => {
		const w = world();
		// Failures at 0, 4, 8 and 12 minutes.
		w.fail("a");
		for (let i = 0; i < 3; i++) {
			w.pass(4 * MINUTE);
			w.fail("a");
		}
		w.pass(3 * MINUTE);
		// At 15 minutes to the millisecond the failure at 0 has gone, and those at 4, 8 and 12 have not.
		w.fail("a");
		expect(w.check("a")).toEqual(FREE);
		w.pass(MINUTE);
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(1));
	});

	test("each further failure after a block doubles it, to 15 minutes and no further", () => {
		const w = world();
		w.fail("a", 5);
		let seconds = 1;
		const blocks = [seconds];
		for (let i = 0; i < 12; i++) {
			w.pass(seconds * SECOND);
			expect(w.check("a")).toEqual(FREE);
			w.fail("a");
			const answer = w.check("a");
			if (answer.kind !== "blocked") throw new Error(`failure ${6 + i} did not block`);
			seconds = answer.retryAfterSeconds;
			blocks.push(seconds);
		}
		expect(blocks).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 900, 900, 900]);
	});

	test("a failure while the key is blocked doubles the block, counted from that failure", () => {
		// Two attempts that were both let in before either failed: the second failure arrives during the block.
		const w = world();
		w.fail("a", 5);
		w.pass(400);
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(2));
		w.pass(2 * SECOND - 1);
		expect(w.check("a")).toEqual(blocked(1));
		w.pass(1);
		expect(w.check("a")).toEqual(FREE);
	});

	test("asking during a block is not a failure: it does not lengthen the block or the next one", () => {
		const w = world();
		w.fail("a", 5);
		for (let i = 0; i < 999; i++) {
			expect(w.check("a")).toEqual(blocked(1));
			w.pass(1);
		}
		w.pass(1);
		expect(w.check("a")).toEqual(FREE);
		expect(w.limiter.size).toBe(1);
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(2));
	});

	test("asking about a key that never failed keeps nothing", () => {
		const w = world();
		expect(w.check("a", "b")).toEqual(FREE);
		expect(w.limiter.size).toBe(0);
	});

	test("a key is forgotten 15 minutes after its block ended, and not before", () => {
		const w = world();
		w.fail("a", 5);
		w.pass(SECOND + 15 * MINUTE - 1);
		// One millisecond short: the key still has its 1 second, and this failure doubles it.
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(2));
		w.pass(2 * SECOND + 15 * MINUTE);
		w.fail("a", 4);
		expect(w.check("a")).toEqual(FREE);
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(1));
	});

	test("a key that was blocked is counted for as long as it is remembered, however few of its failures are recent", () => {
		const w = world();
		w.fail("a", 5);
		w.pass(13 * MINUTE);
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(2));
		w.pass(13 * MINUTE);
		// Two failures in the last 15 minutes, and the seventh since the key was last forgotten.
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(4));
	});

	test("a success clears the keys it is given and no others", () => {
		const w = world();
		const keys = ["addr:203.0.113.9", "prefix:Ab3dE9xQ"];
		for (let i = 0; i < 4; i++) w.limiter.failed(keys, START);
		w.limiter.succeeded(["prefix:Ab3dE9xQ"]);
		expect(w.limiter.size).toBe(1);
		w.limiter.failed(keys, START);
		expect(w.check("prefix:Ab3dE9xQ")).toEqual(FREE);
		expect(w.check("addr:203.0.113.9")).toEqual(blocked(1));
		expect(w.check(...keys)).toEqual(blocked(1));
	});

	test("a success ends a block and what led to it", () => {
		const w = world();
		w.fail("a", 9);
		expect(w.check("a")).toEqual(blocked(16));
		w.limiter.succeeded(["a", "a key that never failed"]);
		expect(w.check("a")).toEqual(FREE);
		w.fail("a", 4);
		expect(w.check("a")).toEqual(FREE);
		w.fail("a");
		expect(w.check("a")).toEqual(blocked(1));
	});

	test("several keys: no while any of them is blocked, for as long as the longest block", () => {
		const w = world();
		w.fail("a", 5);
		w.fail("b", 7);
		expect(w.check("a")).toEqual(blocked(1));
		expect(w.check("b")).toEqual(blocked(4));
		expect(w.check("a", "b", "c")).toEqual(blocked(4));
		expect(w.check("b", "a")).toEqual(blocked(4));
		expect(w.check("c")).toEqual(FREE);
		expect(w.check()).toEqual(FREE);
		w.pass(SECOND);
		expect(w.check("a")).toEqual(FREE);
		expect(w.check("a", "b")).toEqual(blocked(3));
		w.pass(3 * SECOND);
		expect(w.check("a", "b")).toEqual(FREE);
	});

	test("the wait is in whole seconds, rounded up, and never 0", () => {
		const w = world();
		w.fail("a", 7);
		const waits: number[] = [];
		for (const at of [0, 1, 999, 1000, 1001, 2999, 3000, 3001, 3999]) {
			const answer = w.limiter.check(["a"], START + at);
			waits.push(answer.kind === "blocked" ? answer.retryAfterSeconds : 0);
		}
		expect(waits).toEqual([4, 4, 4, 3, 3, 2, 1, 1, 1]);
		expect(w.limiter.check(["a"], START + 4000)).toEqual(FREE);
	});

	test("a failure for several keys is one failure for each, and a key named twice counts once", () => {
		const w = world();
		for (let i = 0; i < 4; i++) w.limiter.failed(["a", "b", "a", "a"], START);
		expect(w.check("a", "b")).toEqual(FREE);
		w.limiter.failed(["a", "a"], START);
		expect(w.check("a")).toEqual(blocked(1));
		expect(w.check("b")).toEqual(FREE);
	});

	test("two limiters do not share what they count", () => {
		const one = createLimiter();
		const other = createLimiter();
		for (let i = 0; i < 5; i++) one.failed(["a"], START);
		expect(one.check(["a"], START)).toEqual(blocked(1));
		expect(other.check(["a"], START)).toEqual(FREE);
		expect(other.size).toBe(0);
	});

	test("a clock that was set back does not turn a block into a longer one", () => {
		const w = world();
		w.fail("a", 15);
		expect(w.check("a")).toEqual(blocked(900));
		expect(w.limiter.check(["a"], START - 60 * MINUTE)).toEqual(FREE);
		expect(w.limiter.check(["a"], START - 1)).toEqual(FREE);
	});
});

describe("the bound", () => {
	/** A key with four failures is one failure from a block for as long as the limiter remembers it. */
	const remembers = (w: ReturnType<typeof world>, key: string): boolean => {
		w.fail(key);
		return w.check(key).kind === "blocked";
	};

	test("it never holds more keys than it was told to", () => {
		const w = world({ maxKeys: 3 });
		for (let i = 0; i < 50; i++) {
			w.fail(`key ${i}`, 1 + (i % 7));
			w.pass(i * SECOND);
			expect(w.limiter.size).toBeLessThanOrEqual(3);
		}
		expect(w.limiter.size).toBe(3);
	});

	test("10,000 keys by default: the next one pushes out the key that failed longest ago", () => {
		const w = world();
		w.fail("first", 4);
		w.pass(1);
		for (let i = 1; i < 10_000; i++) w.fail(`key ${i}`);
		expect(w.limiter.size).toBe(10_000);
		w.fail("one more");
		expect(w.limiter.size).toBe(10_000);
		expect(remembers(w, "first")).toBe(false);
	});

	test("a full limiter remembers every key until a new one comes", () => {
		const w = world();
		w.fail("first", 4);
		w.pass(1);
		for (let i = 1; i < 10_000; i++) w.fail(`key ${i}`);
		expect(remembers(w, "first")).toBe(true);
	});

	test("when full, keys whose time has passed go first and the others stay", () => {
		const w = world({ maxKeys: 3 });
		w.fail("a", 4);
		w.pass(MINUTE);
		w.fail("b", 4);
		w.pass(MINUTE);
		w.fail("c", 4);
		// 15 minutes after its last failure `a` is nothing but a row. `b` and `c` still count.
		w.pass(13 * MINUTE);
		w.fail("new");
		expect(w.limiter.size).toBe(3);
		expect(remembers(w, "b")).toBe(true);
		expect(remembers(w, "c")).toBe(true);
	});

	test("a key that is still remembered after its block is not dropped for one whose time has passed", () => {
		const w = world({ maxKeys: 3 });
		// `blocked` has the oldest last failure of the three and is remembered until 15 minutes after its block.
		w.fail("blocked", 5);
		w.pass(500);
		w.fail("passed");
		w.pass(14 * MINUTE);
		w.fail("recent");
		w.pass(MINUTE + 200);
		w.fail("new");
		expect(w.limiter.size).toBe(3);
		w.fail("blocked");
		expect(w.check("blocked")).toEqual(blocked(2));
	});

	test("when full of keys that still count, the one with the oldest last failure is dropped", () => {
		const w = world({ maxKeys: 3 });
		w.fail("a", 3);
		w.pass(SECOND);
		w.fail("b", 4);
		w.pass(SECOND);
		w.fail("c", 4);
		w.pass(SECOND);
		// `a` was seen first and failed last, so it is `b` that goes.
		w.fail("a");
		w.pass(SECOND);
		w.fail("new");
		expect(w.limiter.size).toBe(3);
		expect(remembers(w, "a")).toBe(true);
		expect(remembers(w, "c")).toBe(true);
		expect(remembers(w, "b")).toBe(false);
	});

	test("a bound that would count nothing is refused", () => {
		for (const maxKeys of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createLimiter({ maxKeys })).toThrow(RangeError);
		}
		expect(createLimiter({ maxKeys: 1 }).size).toBe(0);
	});
});

describe("prefixKey", () => {
	const cases: [secret: string, key: string | null][] = [
		["cb_Ab3dE9xQk2Lm8Pq4Rs6Tu0Vw1Xy3Za5Bc", "prefix:Ab3dE9xQ"],
		["cb_Ab3dE9xQ", "prefix:Ab3dE9xQ"],
		["cb_Ab3dE9xQ-and-any-other-ending", "prefix:Ab3dE9xQ"],
		// A token the operator set by hand has no marker.
		["Ab3dE9xQ-set-by-hand", "prefix:Ab3dE9xQ"],
		["12345678", "prefix:12345678"],
		["123456789", "prefix:12345678"],
		// Shorter than 8 characters: the whole secret.
		["1234567", "prefix:1234567"],
		["cb_short", "prefix:short"],
		["short", "prefix:short"],
		["x", "prefix:x"],
		["cb_x", "prefix:x"],
		[" ", "prefix: "],
		// Nothing to tell it from another: no key, so that it is not one key for everybody who sends nothing.
		["", null],
		["cb_", null],
		// Only the marker itself, at the start, once.
		["cb", "prefix:cb"],
		["CB_", "prefix:CB_"],
		["CB_Ab3dE9xQk2", "prefix:CB_Ab3dE"],
		["xcb_Ab3dE9xQk2", "prefix:xcb_Ab3d"],
		["cb_cb_Ab3dE9xQk2", "prefix:cb_Ab3dE"],
		["cb_cb_", "prefix:cb_"],
	];
	for (const [secret, key] of cases) {
		test(`${JSON.stringify(secret)} is counted under ${JSON.stringify(key)}`, () => {
			expect(prefixKey(secret)).toBe(key);
		});
	}

	test("a key is never empty and never holds more than 8 characters of what was presented", () => {
		const secret = fc.oneof(
			fc.string({ maxLength: 200 }),
			fc.string({ maxLength: 12 }).map((rest) => `cb_${rest}`),
		);
		fc.assert(
			fc.property(secret, (presented) => {
				const key = prefixKey(presented);
				expect(key === null).toBe(presented === "" || presented === "cb_");
				if (key === null) return;
				const kept = key.slice("prefix:".length);
				expect(kept.length).toBeGreaterThanOrEqual(1);
				expect(kept.length).toBeLessThanOrEqual(8);
				expect(presented).toContain(kept);
			}),
			{ numRuns: 500 },
		);
	});
});

describe("isGeneratedSecret", () => {
	const body = "aZ09bY18cX27dW36eV45fU54gT63hS72";
	const cases: [secret: string, generated: boolean][] = [
		[`cb_${body}`, true],
		[`cb_${"0".repeat(32)}`, true],
		[`cb_${"z".repeat(32)}`, true],
		[`cb_${"Z".repeat(32)}`, true],
		// One character short, one too many.
		[`cb_${body.slice(1)}`, false],
		[`cb_${body}0`, false],
		// The marker, exactly, at the start.
		[body, false],
		[`${body}abc`, false],
		[`CB_${body}`, false],
		[`cb-${body}`, false],
		[`xcb_${body}`, false],
		[`cb_cb_${body.slice(3)}`, false],
		// A character outside the alphabet, anywhere.
		[`cb_${body.slice(1)}-`, false],
		[`cb_-${body.slice(1)}`, false],
		[`cb_${body.slice(0, 15)}_${body.slice(16)}`, false],
		[`cb_${body.slice(1)}é`, false],
		[`cb_${body.slice(1)} `, false],
		// Nothing around it.
		[` cb_${body}`, false],
		[`cb_${body} `, false],
		[`cb_${body}\n`, false],
		[`cb_${body}\ncb_${body}`, false],
		// What a person chooses.
		["", false],
		["cb_", false],
		["correct horse battery staple", false],
		["an-owner-token-set-in-the-environment", false],
	];
	for (const [secret, generated] of cases) {
		test(`${JSON.stringify(secret)} is ${generated ? "" : "not "}in the generated format`, () => {
			expect(isGeneratedSecret(secret)).toBe(generated);
		});
	}

	test("the marker and any 32 characters of the alphabet are, and one character changed for another kind is not", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[0-9a-zA-Z]{32}$/),
				fc.integer({ min: 0, max: 31 }),
				fc.constantFrom("-", "_", " ", "+", "/", "=", ".", "é"),
				(made, at, other) => {
					expect(isGeneratedSecret(`cb_${made}`)).toBe(true);
					expect(isGeneratedSecret(`cb_${made.slice(0, at)}${other}${made.slice(at + 1)}`)).toBe(false);
				},
			),
		);
	});
});

describe("addresses", () => {
	// Each address, and the key it is counted under: null for one that is loopback or private and never counted.
	const cases: [address: string, key: string | null][] = [
		// IPv4, each range at both of its ends and one step outside.
		["127.0.0.1", null],
		["127.255.255.255", null],
		["126.255.255.255", "addr:126.255.255.255"],
		["128.0.0.0", "addr:128.0.0.0"],
		["10.0.0.0", null],
		["10.255.255.255", null],
		["9.255.255.255", "addr:9.255.255.255"],
		["11.0.0.0", "addr:11.0.0.0"],
		["172.16.0.0", null],
		["172.31.255.255", null],
		["172.15.255.255", "addr:172.15.255.255"],
		["172.32.0.0", "addr:172.32.0.0"],
		["192.168.0.0", null],
		["192.168.255.255", null],
		["192.167.255.255", "addr:192.167.255.255"],
		["192.169.0.0", "addr:192.169.0.0"],
		["169.254.0.0", null],
		["169.254.255.255", null],
		["169.253.255.255", "addr:169.253.255.255"],
		["169.255.0.0", "addr:169.255.0.0"],
		["100.64.0.0", null],
		["100.127.255.255", null],
		["100.63.255.255", "addr:100.63.255.255"],
		["100.128.0.0", "addr:100.128.0.0"],
		["203.0.113.9", "addr:203.0.113.9"],
		["0.0.0.0", "addr:0.0.0.0"],
		["255.255.255.255", "addr:255.255.255.255"],
		[" 203.0.113.9 ", "addr:203.0.113.9"],
		[" 10.0.0.1 ", null],
		// IPv6: the ranges that are never counted, and for the others the first 64 bits.
		["::1", null],
		["0:0:0:0:0:0:0:1", null],
		["0000:0000:0000:0000:0000:0000:0000:0001", null],
		["::", "addr:0:0:0:0::/64"],
		["::2", "addr:0:0:0:0::/64"],
		["1::", "addr:1:0:0:0::/64"],
		["fc00::", null],
		["fd12:3456:789a::1", null],
		["FD12:3456:789A::1", null],
		["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", null],
		["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "addr:fbff:ffff:ffff:ffff::/64"],
		["fe00::1", "addr:fe00:0:0:0::/64"],
		["fe80::1", null],
		["fe80::1%eth0", null],
		["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", null],
		["fe7f::1", "addr:fe7f:0:0:0::/64"],
		["fec0::1", "addr:fec0:0:0:0::/64"],
		["ff02::1", "addr:ff02:0:0:0::/64"],
		["2001:db8::1", "addr:2001:db8:0:0::/64"],
		["2001:0DB8:0:0:0:0:0:0001", "addr:2001:db8:0:0::/64"],
		["2001:db8:1:2:3:4:5:6", "addr:2001:db8:1:2::/64"],
		["2001:db8:1:2:3:4:5::", "addr:2001:db8:1:2::/64"],
		["2001:db8:1:2::", "addr:2001:db8:1:2::/64"],
		["2001:db8:1:3::1", "addr:2001:db8:1:3::/64"],
		["2001:db8:1:2::1%eth0", "addr:2001:db8:1:2::/64"],
		// IPv4 written as IPv6: judged and keyed as the IPv4 address it is, whole.
		["::ffff:127.0.0.1", null],
		["::ffff:7f00:1", null],
		["::FFFF:10.1.2.3", null],
		["0:0:0:0:0:ffff:172.16.0.1", null],
		["::ffff:192.168.1.10", null],
		["::ffff:c0a8:10a", null],
		["::ffff:169.254.1.1", null],
		["::ffff:100.100.100.100", null],
		["::ffff:203.0.113.9", "addr:203.0.113.9"],
		["::ffff:203.0.113.10", "addr:203.0.113.10"],
		["::ffff:cb00:7109", "addr:203.0.113.9"],
		["0000:0000:0000:0000:0000:FFFF:CB00:7109", "addr:203.0.113.9"],
		// Not the mapped form: other ways to carry four bytes are IPv6 addresses like any other.
		["::127.0.0.1", "addr:0:0:0:0::/64"],
		["64:ff9b::10.0.0.1", "addr:64:ff9b:0:0::/64"],
		["1::ffff:10.0.0.1", "addr:1:0:0:0::/64"],
		// Not an address: public, and counted as it stands.
		["unknown", "addr:unknown"],
		["localhost", "addr:localhost"],
		["10.0.0", "addr:10.0.0"],
		["10.0.0.1.2", "addr:10.0.0.1.2"],
		["10.0.0.256", "addr:10.0.0.256"],
		["010.0.0.1", "addr:010.0.0.1"],
		["0x7f.0.0.1", "addr:0x7f.0.0.1"],
		["127.1", "addr:127.1"],
		["2130706433", "addr:2130706433"],
		["-127.0.0.1", "addr:-127.0.0.1"],
		["127.0.0.1e0", "addr:127.0.0.1e0"],
		["１２７.0.0.1", "addr:１２７.0.0.1"],
		["10.0.0.1/8", "addr:10.0.0.1/8"],
		["127.0.0.1:8080", "addr:127.0.0.1:8080"],
		["10.0.0.1, 203.0.113.9", "addr:10.0.0.1, 203.0.113.9"],
		["10.0.0.1%eth0", "addr:10.0.0.1%eth0"],
		["::1%", "addr:::1%"],
		["::1%eth0, 203.0.113.9", "addr:::1%eth0, 203.0.113.9"],
		["[::1]", "addr:[::1]"],
		[":::1", "addr::::1"],
		["::1::", "addr:::1::"],
		[":1", "addr::1"],
		["1:", "addr:1:"],
		["::g", "addr:::g"],
		["::12345", "addr:::12345"],
		["1:2:3:4:5:6:7", "addr:1:2:3:4:5:6:7"],
		["1:2:3:4:5:6:7:8:9", "addr:1:2:3:4:5:6:7:8:9"],
		["1:2:3:4:5:6:7:8::", "addr:1:2:3:4:5:6:7:8::"],
		["::ffff:10.0.0.256", "addr:::ffff:10.0.0.256"],
		["::ffff:10.0.0", "addr:::ffff:10.0.0"],
		["10.0.0.1::", "addr:10.0.0.1::"],
		["::10.0.0.1:1", "addr:::10.0.0.1:1"],
	];
	for (const [address, key] of cases) {
		const verdict = key === null ? "loopback or private, and never counted" : `counted under ${JSON.stringify(key)}`;
		test(`${JSON.stringify(address)} is ${verdict}`, () => {
			expect(isLoopbackOrPrivate(address)).toBe(key === null);
			expect(addressKey(address)).toBe(key);
		});
	}

	test("an address that is unknown has no key, and is not loopback or private either", () => {
		expect(addressKey(null)).toBeNull();
		for (const unknown of ["", " ", "\t\n"]) {
			expect(addressKey(unknown)).toBeNull();
			expect(isLoopbackOrPrivate(unknown)).toBe(false);
		}
	});

	test("every address of one IPv6 /64 is counted as one, and the next /64 apart from it", () => {
		const w = world();
		const guesses = [
			"2001:db8:1:2::1",
			"2001:db8:1:2:aaaa:bbbb:cccc:dddd",
			"2001:DB8:1:2::ffff",
			"2001:db8:1:2:1::",
			"2001:db8:1:2::5",
		];
		for (const from of guesses) {
			const key = addressKey(from);
			if (key === null) throw new Error(`${from} has no key`);
			w.fail(key);
		}
		expect(w.limiter.size).toBe(1);
		expect(w.check(addressKey("2001:db8:1:2::6") ?? "")).toEqual(blocked(1));
		expect(w.check(addressKey("2001:db8:1:3::1") ?? "")).toEqual(FREE);
	});

	test("text that is not an address is cut to the length of one before it is a key", () => {
		expect(addressKey("x".repeat(5000))).toBe(`addr:${"x".repeat(45)}`);
		expect(addressKey(`  ${"x".repeat(5000)}  `)).toBe(`addr:${"x".repeat(45)}`);
	});

	test("any text has an answer, and is counted exactly when it is known and not loopback or private", () => {
		const text = fc.oneof(
			fc.string({ maxLength: 60 }),
			fc.ipV4(),
			fc.ipV6(),
			fc.ipV4().map((quad) => `::ffff:${quad}`),
		);
		fc.assert(
			fc.property(text, (address) => {
				const key = addressKey(address);
				expect(key === null).toBe(address.trim() === "" || isLoopbackOrPrivate(address));
				if (key !== null) expect(key.length).toBeLessThanOrEqual("addr:".length + 45);
			}),
			{ numRuns: 1000 },
		);
	});
});

describe("as a surface uses it", () => {
	const GENERATED = "cb_Ab3dE9xQk2Lm8Pq4Rs6Tu0Vw1Xy3Za5B";
	const CHOSEN = "Ab3dE9xQ-set-by-hand";
	const wrong = (ending: number): string => `cb_Ab3dE9xQ${String(ending).padStart(24, "0")}`;

	const instances: Harness[] = [];
	afterEach(async () => {
		for (const h of instances.splice(0)) h.close();
	});

	async function caller() {
		const h = await harness();
		instances.push(h);
		for (const secret of [GENERATED, CHOSEN]) {
			const token = await createToken(h.app, { actor: "robin", kind: "human", can: [], project: 0, label: "test" });
			h.app.db.raw
				.query("UPDATE tokens SET hash = ?, source = ? WHERE id = ?")
				.run(hashToken(secret), secret === CHOSEN ? "env" : null, token.id);
		}
		return {
			limiter: limiterOf(h.app),
			admit: async (from: string | null, secret: string): Promise<string> => {
				const answer = await admit(h.app, {
					bearer: secret,
					address: from,
					cookie: null,
					sameOrigin: false,
					localOwner: null,
				});
				return answer.kind === "limited"
					? `limited for ${answer.retryAfter} s`
					: answer.kind === "admitted"
						? "admitted"
						: "unauthorized";
			},
			pass: h.advance,
		};
	}

	test("the fifth wrong secret blocks: a secret a person chose is refused unread, a right generated one passes", async () => {
		const c = await caller();
		for (let i = 0; i < 5; i++) expect(await c.admit("203.0.113.9", wrong(i))).toBe("unauthorized");
		expect(await c.admit("203.0.113.9", wrong(5))).toBe("limited for 1 s");
		expect(await c.admit("203.0.113.9", CHOSEN)).toBe("limited for 1 s");
		expect(await c.admit("203.0.113.9", GENERATED)).toBe("admitted");
		// The prefix is blocked for every address, and another prefix from another address is not.
		expect(await c.admit("198.51.100.7", CHOSEN)).toBe("limited for 1 s");
		expect(await c.admit("198.51.100.7", GENERATED)).toBe("admitted");
		expect(await c.admit("198.51.100.7", "cb_another-secret")).toBe("unauthorized");
	});

	test("nothing that came during the block was reported: the next failure doubles it once, from 1 second", async () => {
		const c = await caller();
		for (let i = 0; i < 5; i++) await c.admit("203.0.113.9", wrong(i));
		for (let i = 0; i < 50; i++) {
			await c.admit("203.0.113.9", wrong(100 + i));
			await c.admit("203.0.113.9", CHOSEN);
			await c.admit("203.0.113.9", GENERATED);
		}
		await c.pass(SECOND);
		expect(await c.admit("203.0.113.9", wrong(5))).toBe("unauthorized");
		expect(await c.admit("203.0.113.9", wrong(6))).toBe("limited for 2 s");
	});

	test("a success clears the prefix and never the address", async () => {
		const c = await caller();
		for (let i = 0; i < 4; i++) await c.admit("203.0.113.9", wrong(i));
		expect(await c.admit("203.0.113.9", CHOSEN)).toBe("admitted");
		expect(c.limiter.size).toBe(1);
		expect(await c.admit("203.0.113.9", "cb_another-secret")).toBe("unauthorized");
		expect(await c.admit("203.0.113.9", GENERATED)).toBe("admitted");
		expect(await c.admit("203.0.113.9", CHOSEN)).toBe("limited for 1 s");
		expect(await c.admit("198.51.100.7", CHOSEN)).toBe("admitted");
	});

	test("a peer that is a proxy, or unknown, is counted by prefix alone", async () => {
		const c = await caller();
		let attempts = 0;
		for (const from of ["127.0.0.1", "::ffff:10.0.0.5", null, ""]) {
			// Twenty wrong secrets from each, no two with the same first 8 characters.
			for (let i = 0; i < 20; i++) {
				attempts += 1;
				expect(await c.admit(from, `cb_${String(attempts).padStart(8, "0")}`)).toBe("unauthorized");
			}
		}
		// One key for each prefix, and none for an address.
		expect(c.limiter.size).toBe(80);
		for (let i = 0; i < 5; i++) await c.admit("127.0.0.1", wrong(i));
		expect(await c.admit("::1", CHOSEN)).toBe("limited for 1 s");
	});

	test("a secret with no prefix key is counted by address alone, and by nothing behind a proxy", async () => {
		const c = await caller();
		for (let i = 0; i < 20; i++) expect(await c.admit("127.0.0.1", i % 2 ? "" : "cb_")).toBe("unauthorized");
		expect(c.limiter.size).toBe(0);
		for (let i = 0; i < 5; i++) expect(await c.admit("203.0.113.9", "")).toBe("unauthorized");
		expect(await c.admit("203.0.113.9", "cb_")).toBe("limited for 1 s");
		expect(c.limiter.size).toBe(1);
	});
});

describe("for any sequence of failures, successes and waits", () => {
	const KEYS = ["addr:203.0.113.9", "prefix:Ab3dE9xQ", "prefix:Zz9yX8wV"];
	const WINDOW = 15 * MINUTE;

	type Step =
		| { readonly kind: "fail"; readonly keys: readonly string[] }
		| { readonly kind: "succeed"; readonly keys: readonly string[] }
		| { readonly kind: "pass"; readonly ms: number };

	const someKeys = fc.subarray(KEYS, { minLength: 1 });
	const step: fc.Arbitrary<Step> = fc.oneof(
		{ weight: 6, arbitrary: someKeys.map((keys): Step => ({ kind: "fail", keys })) },
		{ weight: 1, arbitrary: someKeys.map((keys): Step => ({ kind: "succeed", keys })) },
		{
			weight: 4,
			arbitrary: fc
				.oneof(
					fc.integer({ min: 0, max: 2 * SECOND }),
					fc.integer({ min: 0, max: 20 * MINUTE }),
					fc.integer({ min: 0, max: 45 * MINUTE }),
					fc.constantFrom(SECOND, WINDOW - 1, WINDOW, WINDOW + SECOND, 2 * WINDOW - 1, 2 * WINDOW),
				)
				.map((ms): Step => ({ kind: "pass", ms })),
		},
	);

	/**
	 * Did five of these failures fall inside 15 minutes, among those the key can still be remembered for? A
	 * silence of 30 minutes outlasts the longest block and the 15 minutes after it, so what came before one is
	 * forgotten whatever the limiter kept.
	 */
	const fiveInsideTheWindow = (failures: readonly number[]): boolean => {
		let run: number[] = [];
		for (const at of failures) {
			const before = run.at(-1);
			if (before !== undefined && at - before >= 2 * WINDOW) run = [];
			run.push(at);
		}
		return run.some((first, index) => {
			const fifth = run[index + 4];
			return fifth !== undefined && fifth - first < WINDOW;
		});
	};

	test("a key is never blocked for longer than 15 minutes from now, and never before five failures inside 15 minutes", () => {
		fc.assert(
			fc.property(
				// The size is set because fast-check's own choice is ten steps at most, and it takes fifteen
				// failures of one key to reach the longest block.
				fc.array(step, { maxLength: 150, size: "max" }),
				fc.constantFrom(1, 2, 10_000),
				fc.constantFrom(0, START),
				(steps, maxKeys, start) => {
					const limiter = createLimiter({ maxKeys });
					// What the test saw of each key: its failures since its last success.
					const failures = new Map<string, number[]>(KEYS.map((key) => [key, []]));
					let now = start;
					for (const next of steps) {
						if (next.kind === "pass") now += next.ms;
						if (next.kind === "fail") {
							limiter.failed(next.keys, now);
							for (const key of next.keys) failures.get(key)?.push(now);
						}
						if (next.kind === "succeed") {
							limiter.succeeded(next.keys);
							for (const key of next.keys) failures.set(key, []);
						}
						expect(limiter.size).toBeLessThanOrEqual(maxKeys);
						for (const key of KEYS) {
							const seen = failures.get(key) ?? [];
							const answer = limiter.check([key], now);
							// No five failures inside 15 minutes since the key was last cleared or forgotten: free.
							if (!fiveInsideTheWindow(seen)) expect(answer).toEqual(FREE);
							if (answer.kind !== "blocked") continue;
							expect(answer.retryAfterSeconds).toBeGreaterThanOrEqual(1);
							expect(answer.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
							expect(Number.isInteger(answer.retryAfterSeconds)).toBe(true);
							// The wait that was promised is enough, and one second less is not.
							expect(limiter.check([key], now + answer.retryAfterSeconds * SECOND)).toEqual(FREE);
							expect(limiter.check([key], now + (answer.retryAfterSeconds - 1) * SECOND).kind).toBe("blocked");
							expect(limiter.check([key], now + WINDOW)).toEqual(FREE);
							// A block is set by a failure and runs from it: 15 minutes after the last one the key is free.
							expect(now - (seen.at(-1) ?? Number.NEGATIVE_INFINITY)).toBeLessThan(WINDOW);
						}
					}
				},
			),
			{ numRuns: 500 },
		);
	});
});

describe("accountKey", () => {
	test("a name is one key however it is capitalised or padded, and never more than a name's length", () => {
		expect(accountKey("robin")).toBe("account:robin");
		expect(accountKey("Robin")).toBe("account:robin");
		expect(accountKey("  ROBIN\t")).toBe("account:robin");
		expect(accountKey("robin@example.com")).toBe("account:robin@example.com");
		// What a stranger types does not decide how much memory a key takes.
		expect(accountKey("x".repeat(5000))).toBe(`account:${"x".repeat(64)}`);
		expect(accountKey(`${"a".repeat(64)}b`)).toBe(accountKey(`${"A".repeat(64)}c`));
		// Another name is another key, and no key is one a token or an address is counted under.
		expect(accountKey("robin")).not.toBe(accountKey("robina"));
		expect(accountKey("203.0.113.9")).not.toBe(addressKey("203.0.113.9"));
		expect(accountKey("robin")).not.toBe(prefixKey("robin"));
	});

	test("a name that is empty or only spaces has no key: it would be one key for everybody who sends nothing", () => {
		for (const name of ["", " ", "\t\n "]) expect(accountKey(name)).toBeNull();
	});

	test("the fifth failure for a name blocks it under any spelling, and a success for it clears it", () => {
		const w = world();
		w.fail(accountKey("robin") ?? "", 3);
		w.fail(accountKey("ROBIN") ?? "", 2);
		expect(w.check(accountKey("Robin") ?? "")).toEqual(blocked(1));
		expect(w.check(accountKey("sam") ?? "")).toEqual(FREE);
		w.limiter.succeeded([accountKey("robin") ?? ""]);
		expect(w.check(accountKey("ROBIN") ?? "")).toEqual(FREE);
	});
});
