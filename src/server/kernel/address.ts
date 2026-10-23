// What an IP address looks like in writing, and which addresses a list of ranges names. Pure: text goes in and an
// answer comes out. It is in the kernel because the configuration is: `defaultConfig` reads the list of trusted
// proxies with it before anything is opened, and the limit on failed authentication (`identity/limiter.ts`) and
// the HTTP surface read a peer's and a header's address with the same grammar, so no two of them can disagree
// about what an address is.
//
// The grammar is strict on purpose. Whatever is not exactly one address is not an address: a reader that guessed
// at `010.0.0.1`, at a port or at a list would be guessing whom to believe.

type Quad = readonly [number, number, number, number];
/** An address that was read. An IPv4 address written as IPv6 (`::ffff:a.b.c.d`) is the IPv4 address. */
export type Address =
	| { readonly kind: "v4"; readonly bytes: Quad }
	| { readonly kind: "v6"; readonly groups: readonly number[] };

/** The longest an address is in writing: an IPv6 address that ends in a dotted quad. */
export const ADDRESS_LENGTH = 45;
/** The name of an interface after a link-local address, as in `fe80::1%eth0`. */
const ZONE = /%[0-9a-z_.-]+$/i;

function parseQuad(text: string): Quad | null {
	// No leading zeros: `010.0.0.1` is 8.0.0.1 to some readers and 10.0.0.1 to others.
	const [a, b, c, d, ...more] = text.split(".").map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : 256));
	if (a === undefined || b === undefined || c === undefined || d === undefined || more.length > 0) return null;
	return Math.max(a, b, c, d) <= 255 ? [a, b, c, d] : null;
}

/** The 16-bit groups written in one side of an IPv6 address. Only the end of the address may be a dotted quad. */
function parseGroups(text: string, mayEndInQuad: boolean): number[] | null {
	if (text === "") return [];
	const parts = text.split(":");
	const groups: number[] = [];
	for (const [index, part] of parts.entries()) {
		if (/^[0-9a-f]{1,4}$/i.test(part)) {
			groups.push(Number.parseInt(part, 16));
			continue;
		}
		const quad = mayEndInQuad && index === parts.length - 1 ? parseQuad(part) : null;
		if (!quad) return null;
		groups.push(quad[0] * 256 + quad[1], quad[2] * 256 + quad[3]);
	}
	return groups;
}

/**
 * One address, written with nothing around it: no spaces, brackets, port or list. `zoned` allows the name of an
 * interface after an IPv6 address, which a socket may report for a link-local peer and which is not part of the
 * address. A header and a list of ranges have no use for one.
 */
export function parseAddress(text: string, zoned: boolean): Address | null {
	const quad = parseQuad(text);
	if (quad) return { kind: "v4", bytes: quad };
	const sides = (zoned ? text.replace(ZONE, "") : text).split("::");
	if (sides.length > 2) return null;
	const [head = "", tail] = sides;
	const front = parseGroups(head, tail === undefined);
	const back = tail === undefined ? [] : parseGroups(tail, true);
	if (!front || !back) return null;
	const missing = 8 - front.length - back.length;
	// Without `::` all eight groups are written; `::` stands for at least one.
	if (tail === undefined ? missing !== 0 : missing < 1) return null;
	const groups = [...front, ...new Array<number>(missing).fill(0), ...back];
	// `::ffff:a.b.c.d` is how a socket that listens on both families reports an IPv4 peer. It is that IPv4
	// address, and is judged, keyed and matched as one.
	const [, , , , , marker = 0, high = 0, low = 0] = groups;
	if (marker === 0xffff && groups.slice(0, 5).every((group) => group === 0)) {
		return { kind: "v4", bytes: [high >> 8, high & 0xff, low >> 8, low & 0xff] };
	}
	return { kind: "v6", groups };
}

/** Whether an address that was read is loopback or private. The ranges are listed at `isLoopbackOrPrivate`. */
export function inPrivateRange(address: Address): boolean {
	if (address.kind === "v4") {
		const [a, b] = address.bytes;
		return (
			a === 127 ||
			a === 10 ||
			(a === 172 && (b & 0xf0) === 16) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			// 100.64/10: carrier-grade NAT, and the range a tailnet gives its machines.
			(a === 100 && (b & 0xc0) === 64)
		);
	}
	const [first = 0] = address.groups;
	return address.groups.join(":") === "0:0:0:0:0:0:0:1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * Is this the address of this machine or of its own network: IPv4 127/8, 10/8, 172.16/12, 192.168/16,
 * 169.254/16 and 100.64/10; IPv6 ::1, fc00::/7 and fe80::/10; and an IPv4 one of those written as IPv6?
 *
 * A request from such a peer comes through a proxy, or from the machine itself. Its address is never counted:
 * every visitor behind the proxy shares it, and one of them could block the rest.
 *
 * Text that is not an address is not one of these.
 */
export function isLoopbackOrPrivate(address: string): boolean {
	const parsed = parseAddress(address.trim(), true);
	return parsed !== null && inPrivateRange(parsed);
}

/**
 * The one address a header holds, or null: for a header that is missing, and for a value that is anything but
 * one IPv4 or IPv6 address with at most spaces around it. A list, a port, brackets or an interface name make it
 * null, because a proxy that sends one of those is not sending what the operator said it sends, and picking an
 * address out of the value would be a guess at which part to believe.
 */
export function headerAddress(value: string | null): string | null {
	const text = value?.trim() ?? "";
	return parseAddress(text, false) === null ? null : text;
}

/** A range of addresses: the first `bits` bits of `groups`, which has no bit set after them. */
type Range = { readonly groups: readonly number[]; readonly bits: number };

/**
 * An address in the one space both families are matched in, where an IPv4 address is `::ffff:a.b.c.d`. So a
 * peer matches an IPv4 range whichever way its socket wrote it, and `::/0` is every address there is.
 */
function inSharedSpace(address: Address): readonly number[] {
	if (address.kind === "v6") return address.groups;
	const [a, b, c, d] = address.bytes;
	return [0, 0, 0, 0, 0, 0xffff, a * 256 + b, c * 256 + d];
}

/** Which bits of the group at `index` lie inside the first `bits` bits of an address. */
function maskAt(index: number, bits: number): number {
	const inside = Math.min(Math.max(bits - index * 16, 0), 16);
	return (0xffff << (16 - inside)) & 0xffff;
}

const inRange = (groups: readonly number[], range: Range): boolean =>
	range.groups.every((group, index) => ((groups[index] ?? 0) & maskAt(index, range.bits)) === group);

/** An address, or an address and the length of a prefix: `203.0.113.9`, `10.0.0.0/8`, `2001:db8::/32`. */
function parseRange(entry: string): Range | null {
	const slash = entry.indexOf("/");
	const text = slash === -1 ? entry : entry.slice(0, slash);
	const address = parseAddress(text, false);
	if (!address) return null;
	// The length counts from the start of the address as it was written: `/8` of a dotted quad is 8 of its 32 bits.
	const width = parseQuad(text) ? 32 : 128;
	const length = slash === -1 ? `${width}` : entry.slice(slash + 1);
	if (!/^(0|[1-9]\d{0,2})$/.test(length) || Number(length) > width) return null;
	return { groups: inSharedSpace(address), bits: 128 - width + Number(length) };
}

/** A list that was read. `contains` is false for an address that is unknown or is not an address. */
export type AddressRanges = {
	readonly kind: "ranges";
	readonly source: string;
	readonly contains: (address: string | null) => boolean;
};
/** A list that was not: `entry` is the first entry at fault, and `why` ends the sentence that starts with it. */
export type MalformedAddressRanges = { readonly kind: "malformed"; readonly entry: string; readonly why: string };

/**
 * Reads a list of addresses and ranges, separated by commas: `10.0.0.0/8, 2001:db8::/32, 203.0.113.9`. This is
 * `MAINWORTHY_TRUSTED_PROXY`, the peers whose word for the client's address is believed. An empty list is a
 * list that contains no address.
 *
 * An entry that cannot be read makes the whole list `malformed`, for the caller to show and stop on: a proxy
 * left out by a typing error is a peer like any other, and all its visitors are then one address. A range
 * whose address has bits after its prefix, `10.0.0.5/8`, is refused too, because it reads as one machine and
 * would trust sixteen million.
 */
export function parseAddressRanges(list: string): AddressRanges | MalformedAddressRanges {
	const ranges: Range[] = [];
	for (const entry of list.split(",").map((part) => part.trim())) {
		if (entry === "") continue;
		const range = parseRange(entry);
		if (!range) return { kind: "malformed", entry, why: "is not an address or a range such as 10.0.0.0/8" };
		if (!inRange(range.groups, range)) {
			return { kind: "malformed", entry, why: "has bits set after its prefix; a range starts at its first address" };
		}
		ranges.push(range);
	}
	return {
		kind: "ranges",
		source: list,
		contains: (address) => {
			const parsed = parseAddress(address?.trim() ?? "", true);
			if (!parsed) return false;
			const groups = inSharedSpace(parsed);
			return ranges.some((range) => inRange(groups, range));
		},
	};
}
