// One address in a header, and a list of ranges. Which addresses are counted, and that a private one is not, is
// tested with the key an address is counted under (`identity/limiter.test.ts`).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { headerAddress, parseAddressRanges } from "./address.ts";

describe("headerAddress", () => {
	const cases: [value: string | null, address: string | null][] = [
		["203.0.113.9", "203.0.113.9"],
		[" 203.0.113.9 ", "203.0.113.9"],
		["\t2001:db8::1\t", "2001:db8::1"],
		["2001:DB8:0:0:0:0:0:1", "2001:DB8:0:0:0:0:0:1"],
		["::ffff:203.0.113.9", "::ffff:203.0.113.9"],
		["2001:db8::203.0.113.9", "2001:db8::203.0.113.9"],
		// A private address is an address. Whether it is counted is `addressKey`'s to say.
		["10.0.0.1", "10.0.0.1"],
		["::1", "::1"],
		// Missing.
		[null, null],
		["", null],
		["  ", null],
		// A list.
		["203.0.113.9, 10.0.0.1", null],
		["203.0.113.9,10.0.0.1", null],
		["203.0.113.9 10.0.0.1", null],
		["203.0.113.9\n10.0.0.1", null],
		["203.0.113.9,", null],
		[",203.0.113.9", null],
		["2001:db8::1, 2001:db8::2", null],
		// A port, brackets, an interface, a range.
		["203.0.113.9:443", null],
		["[2001:db8::1]", null],
		["[2001:db8::1]:443", null],
		["[203.0.113.9]", null],
		["fe80::1%eth0", null],
		["203.0.113.9/32", null],
		["2001:db8::/32", null],
		// Not an address.
		["unknown", null],
		["for=203.0.113.9", null],
		['"203.0.113.9"', null],
		["_hidden", null],
		["203.0.113.256", null],
		["203.0.113", null],
		["010.0.0.1", null],
		["2001:db8::1::", null],
		["2001:db8:::1", null],
		["１２７.0.0.1", null],
	];
	for (const [value, address] of cases) {
		test(`${JSON.stringify(value)} holds ${address === null ? "no address" : address}`, () => {
			expect(headerAddress(value)).toBe(address);
		});
	}

	test("what it gives back is an address and nothing else, whatever the header says", () => {
		const value = fc.oneof(
			fc.string({ maxLength: 60 }),
			fc.ipV4(),
			fc.ipV6(),
			fc
				.tuple(fc.ipV4(), fc.constantFrom(", ", ",", " ", ":80", "/24", "%eth0"), fc.ipV4())
				.map((parts) => parts.join("")),
		);
		fc.assert(
			fc.property(value, (header) => {
				const address = headerAddress(header);
				if (address === null) return;
				expect(address).toBe(header.trim());
				expect(address).toMatch(/^[0-9a-fA-F:.]{2,45}$/);
			}),
			{ numRuns: 1000 },
		);
	});
});

describe("parseAddressRanges", () => {
	/** The matcher of a list that must be well formed. */
	const ranges = (list: string): ((address: string | null) => boolean) => {
		const parsed = parseAddressRanges(list);
		if (parsed.kind !== "ranges") throw new Error(`${parsed.entry} ${parsed.why}`);
		return parsed.contains;
	};

	const inside: [list: string, address: string | null, contained: boolean][] = [
		// An empty list contains nothing.
		["", "203.0.113.9", false],
		["", "127.0.0.1", false],
		["  ", "::1", false],
		[" , ,", "10.0.0.1", false],
		// One address.
		["203.0.113.9", "203.0.113.9", true],
		["203.0.113.9", "203.0.113.10", false],
		["203.0.113.9", "203.0.113.8", false],
		["203.0.113.9/32", "203.0.113.9", true],
		["203.0.113.9/32", "203.0.113.10", false],
		["2001:db8::1", "2001:db8::1", true],
		["2001:db8::1", "2001:DB8:0:0:0:0:0:1", true],
		["2001:db8::1", "2001:db8::2", false],
		["2001:db8::1/128", "2001:db8::1", true],
		["::1", "::1", true],
		["::1", "::2", false],
		["::1", "127.0.0.1", false],
		["127.0.0.1", "::1", false],
		// IPv4 ranges, at both ends and one step outside.
		["10.0.0.0/8", "10.0.0.0", true],
		["10.0.0.0/8", "10.255.255.255", true],
		["10.0.0.0/8", "9.255.255.255", false],
		["10.0.0.0/8", "11.0.0.0", false],
		["172.16.0.0/12", "172.16.0.0", true],
		["172.16.0.0/12", "172.31.255.255", true],
		["172.16.0.0/12", "172.15.255.255", false],
		["172.16.0.0/12", "172.32.0.0", false],
		["100.64.0.0/10", "100.127.255.255", true],
		["100.64.0.0/10", "100.128.0.0", false],
		["192.168.1.0/24", "192.168.1.255", true],
		["192.168.1.0/24", "192.168.2.0", false],
		["192.168.1.128/25", "192.168.1.128", true],
		["192.168.1.128/25", "192.168.1.127", false],
		["203.0.113.8/31", "203.0.113.9", true],
		["203.0.113.8/31", "203.0.113.10", false],
		// An IPv4 peer as a socket on both families reports it.
		["10.0.0.0/8", "::ffff:10.1.2.3", true],
		["10.0.0.0/8", "::ffff:a01:203", true],
		["10.0.0.0/8", "0:0:0:0:0:FFFF:10.1.2.3", true],
		["10.0.0.0/8", "::ffff:11.1.2.3", false],
		["203.0.113.9", "::ffff:203.0.113.9", true],
		["203.0.113.9", "::ffff:cb00:7109", true],
		["203.0.113.9", "::ffff:cb00:710a", false],
		// The same range written the other way round.
		["::ffff:10.0.0.0/104", "10.1.2.3", true],
		["::ffff:10.0.0.0/104", "::ffff:10.1.2.3", true],
		["::ffff:10.0.0.0/104", "11.1.2.3", false],
		["::ffff:203.0.113.9", "203.0.113.9", true],
		// Four bytes carried some other way are not that IPv4 address.
		["10.0.0.0/8", "::10.1.2.3", false],
		["10.0.0.0/8", "64:ff9b::10.1.2.3", false],
		// IPv6 ranges, on a boundary between groups and inside one.
		["2001:db8::/32", "2001:db8::", true],
		["2001:db8::/32", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", true],
		["2001:db8::/32", "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", false],
		["2001:db8::/32", "2001:db9::", false],
		["2001:db8:1:2::/64", "2001:db8:1:2:ffff:ffff:ffff:ffff", true],
		["2001:db8:1:2::/64", "2001:db8:1:3::", false],
		["2001:db8::/33", "2001:db8:7fff::1", true],
		["2001:db8::/33", "2001:db8:8000::1", false],
		["fc00::/7", "fdff::1", true],
		["fc00::/7", "fe00::1", false],
		["fe80::/10", "febf::1", true],
		["fe80::/10", "fec0::1", false],
		["fe80::/10", "fe80::1%eth0", true],
		["2001:db8::/127", "2001:db8::1", true],
		["2001:db8::/127", "2001:db8::2", false],
		// Everything of one family, and everything.
		["0.0.0.0/0", "203.0.113.9", true],
		["0.0.0.0/0", "::ffff:203.0.113.9", true],
		["0.0.0.0/0", "2001:db8::1", false],
		["0.0.0.0/0", "::1", false],
		["::/0", "2001:db8::1", true],
		["::/0", "203.0.113.9", true],
		// Several entries, with spaces and a comma too many.
		["192.168.1.0/24, 2001:db8::/32", "192.168.1.77", true],
		["192.168.1.0/24, 2001:db8::/32", "2001:db8:5::1", true],
		["192.168.1.0/24, 2001:db8::/32", "192.168.2.77", false],
		["192.168.1.0/24, 2001:db8::/32", "2001:db9::1", false],
		["192.168.1.0/24,2001:db8::/32", "2001:db8:5::1", true],
		[" 10.0.0.0/8 ,, 203.0.113.9 ,", "203.0.113.9", true],
		[" 10.0.0.0/8 ,, 203.0.113.9 ,", "10.9.9.9", true],
		[" 10.0.0.0/8 ,, 203.0.113.9 ,", "203.0.113.8", false],
		["10.0.0.0/8, 10.0.0.0/8", "10.0.0.1", true],
		// A peer that is unknown, or not an address, is in no list.
		["0.0.0.0/0, ::/0", null, false],
		["0.0.0.0/0, ::/0", "", false],
		["0.0.0.0/0, ::/0", "unknown", false],
		["0.0.0.0/0, ::/0", "10.0.0.1, 10.0.0.2", false],
		["0.0.0.0/0, ::/0", "10.0.0.1:80", false],
		["0.0.0.0/0, ::/0", "[::1]", false],
		["0.0.0.0/0, ::/0", "10.0.0.1/8", false],
		["0.0.0.0/0, ::/0", "010.0.0.1", false],
		["0.0.0.0/0, ::/0", " 10.0.0.1 ", true],
	];
	for (const [list, address, contained] of inside) {
		test(`${JSON.stringify(list)} ${contained ? "contains" : "does not contain"} ${JSON.stringify(address)}`, () => {
			expect(ranges(list)(address)).toBe(contained);
		});
	}

	const NOT_A_RANGE = "is not an address or a range such as 10.0.0.0/8";
	const BITS_AFTER = "has bits set after its prefix; a range starts at its first address";
	const malformed: [list: string, entry: string, why: string][] = [
		["nonsense", "nonsense", NOT_A_RANGE],
		["localhost", "localhost", NOT_A_RANGE],
		["10.0.0.0/8, nonsense", "nonsense", NOT_A_RANGE],
		["10.0.0.0/8,nonsense,also nonsense", "nonsense", NOT_A_RANGE],
		[" 10.0.0 , 10.0.0.0/8", "10.0.0", NOT_A_RANGE],
		// Separated by something other than a comma: the whole of it is the entry that is named.
		["10.0.0.1 10.0.0.2", "10.0.0.1 10.0.0.2", NOT_A_RANGE],
		["10.0.0.0/8;192.168.0.0/16", "10.0.0.0/8;192.168.0.0/16", NOT_A_RANGE],
		// A length that is not one.
		["10.0.0.0/33", "10.0.0.0/33", NOT_A_RANGE],
		["2001:db8::/129", "2001:db8::/129", NOT_A_RANGE],
		["10.0.0.0/", "10.0.0.0/", NOT_A_RANGE],
		["10.0.0.0/08", "10.0.0.0/08", NOT_A_RANGE],
		["10.0.0.0/-1", "10.0.0.0/-1", NOT_A_RANGE],
		["10.0.0.0/8.0", "10.0.0.0/8.0", NOT_A_RANGE],
		["10.0.0.0/8/8", "10.0.0.0/8/8", NOT_A_RANGE],
		["10.0.0.0/ 8", "10.0.0.0/ 8", NOT_A_RANGE],
		["10.0.0.0 /8", "10.0.0.0 /8", NOT_A_RANGE],
		["10.0.0.0/255.0.0.0", "10.0.0.0/255.0.0.0", NOT_A_RANGE],
		["/8", "/8", NOT_A_RANGE],
		// An address that is not one.
		["10.0.0.256/8", "10.0.0.256/8", NOT_A_RANGE],
		["010.0.0.0/8", "010.0.0.0/8", NOT_A_RANGE],
		["10.0.0/8", "10.0.0/8", NOT_A_RANGE],
		["[::1]", "[::1]", NOT_A_RANGE],
		["10.0.0.1:80", "10.0.0.1:80", NOT_A_RANGE],
		["fe80::1%eth0", "fe80::1%eth0", NOT_A_RANGE],
		["fe80::%eth0/10", "fe80::%eth0/10", NOT_A_RANGE],
		["2001:db8::1::/64", "2001:db8::1::/64", NOT_A_RANGE],
		// One machine written with the length of its network.
		["10.0.0.5/8", "10.0.0.5/8", BITS_AFTER],
		["192.168.1.1/24", "192.168.1.1/24", BITS_AFTER],
		["203.0.113.9/31", "203.0.113.9/31", BITS_AFTER],
		["2001:db8::1/32", "2001:db8::1/32", BITS_AFTER],
		["2001:db8:8000::/32", "2001:db8:8000::/32", BITS_AFTER],
		["10.0.0.0/8, 172.16.0.1/12", "172.16.0.1/12", BITS_AFTER],
		["0.0.0.1/0", "0.0.0.1/0", BITS_AFTER],
		["::1/0", "::1/0", BITS_AFTER],
		// An IPv4 address written as IPv6 has its length counted in 128 bits.
		["::ffff:10.0.0.0/8", "::ffff:10.0.0.0/8", BITS_AFTER],
	];
	for (const [list, entry, why] of malformed) {
		test(`${JSON.stringify(list)} is refused, naming ${JSON.stringify(entry)}`, () => {
			expect(parseAddressRanges(list)).toEqual({ kind: "malformed", entry, why });
		});
	}

	test("an IPv4 range holds the addresses that share its prefix and no other, however the peer is written", () => {
		const dotted = (value: number): string => [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 0xffffffff }),
				fc.integer({ min: 0, max: 32 }),
				fc.integer({ min: 0, max: 31 }),
				(address, length, bit) => {
					// Shifting a 32-bit number by 32 places leaves it as it is, so a length of 0 has its own mask.
					const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
					const contains = ranges(`${dotted((address & mask) >>> 0)}/${length}`);
					expect(contains(dotted(address))).toBe(true);
					expect(contains(`::ffff:${dotted(address)}`)).toBe(true);
					const other = (address ^ (0x80000000 >>> bit)) >>> 0;
					expect(contains(dotted(other))).toBe(bit >= length);
					expect(contains(`::ffff:${dotted(other)}`)).toBe(bit >= length);
				},
			),
			{ numRuns: 1000 },
		);
	});

	test("an IPv6 range holds the addresses that share its prefix and no other", () => {
		const written = (groups: readonly number[]): string => groups.map((group) => group.toString(16)).join(":");
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }),
				fc.integer({ min: 0, max: 128 }),
				fc.integer({ min: 0, max: 127 }),
				(groups, length, bit) => {
					// `::ffff:a.b.c.d` is an IPv4 address here, and a range over it is written in other terms.
					fc.pre(written(groups.slice(0, 6)) !== "0:0:0:0:0:ffff");
					const network = groups.map((group, index) => {
						const kept = Math.min(Math.max(length - index * 16, 0), 16);
						return group & ((0xffff << (16 - kept)) & 0xffff);
					});
					const contains = ranges(`${written(network)}/${length}`);
					expect(contains(written(groups))).toBe(true);
					const other = groups.map((group, index) => (index === bit >> 4 ? group ^ (0x8000 >> (bit & 15)) : group));
					fc.pre(written(other.slice(0, 6)) !== "0:0:0:0:0:ffff");
					expect(contains(written(other))).toBe(bit >= length);
				},
			),
			{ numRuns: 1000 },
		);
	});
});
