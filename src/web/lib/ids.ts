import { z } from "zod";

/** Command and draft ids need to work on plain HTTP as well as secure origins. */
export function randomId(): string {
	const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
		const value = index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte;
		return value.toString(16).padStart(2, "0");
	}).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let windowOwner: string | null = null;
export function draftOwner(): string {
	if (windowOwner) return windowOwner;
	try {
		const navigation = performance.getEntriesByType("navigation")[0];
		const reload = navigation instanceof PerformanceNavigationTiming && navigation.type === "reload";
		windowOwner = (reload ? sessionStorage.getItem("mainworthy:draft-window") : null) ?? randomId();
		sessionStorage.setItem("mainworthy:draft-window", windowOwner);
	} catch {
		windowOwner = randomId();
	}
	return windowOwner;
}

const WindowMessage = z.object({ kind: z.enum(["hello", "present", "gone"]), id: z.string(), instance: z.string() });
const liveOwners = new Set<string>();
export function draftOwnerIsLive(owner: string): boolean {
	return liveOwners.has(owner);
}
export function draftOwnedElsewhere(draft: { owner: string }): boolean {
	return draft.owner !== draftOwner() && draftOwnerIsLive(draft.owner);
}
/**
 * Each window holds a lock named for its owner id for as long as its document lives: the browser releases it when
 * the window closes, goes elsewhere or crashes, and a window that starts reads which are held. Over the channel
 * alone a starting window knew the others only by their answer to its hello within 40 ms, and a window busy for
 * longer (a large render, a loaded machine) looked closed: the new window took over the draft it was typing in
 * (issue #406). Web Locks are for secure contexts; on plain HTTP the channel is all there is.
 */
const LOCK = "mainworthy:draft-window:";
async function holdLock(owner: string): Promise<void> {
	await new Promise<void>((held) => {
		void navigator.locks
			.request(LOCK + owner, { mode: "shared" }, () => {
				held();
				return new Promise<never>(() => {});
			})
			.catch(held);
	});
}
/** The owners of the windows that are open, from the locks held; renames this one when another holds its id. */
async function readLocks(): Promise<void> {
	if (typeof navigator === "undefined" || !navigator.locks) return;
	await holdLock(draftOwner());
	const held = (await navigator.locks.query()).held ?? [];
	const owners = held.map((lock) => lock.name ?? "").filter((name) => name.startsWith(LOCK));
	if (owners.filter((name) => name === LOCK + draftOwner()).length > 1) {
		windowOwner = randomId();
		sessionStorage.setItem("mainworthy:draft-window", windowOwner);
		await holdLock(windowOwner);
	}
	for (const name of owners) liveOwners.add(name.slice(LOCK.length));
}
export async function initializeDraftOwners(): Promise<void> {
	await readLocks().catch(() => {});
	if (typeof BroadcastChannel === "undefined") return;
	const instance = randomId();
	const channel = new BroadcastChannel("mainworthy:draft-windows");
	const send = (kind: z.infer<typeof WindowMessage>["kind"]) =>
		channel.postMessage({ kind, id: draftOwner(), instance });
	channel.onmessage = (event: MessageEvent<unknown>) => {
		const parsed = WindowMessage.safeParse(event.data);
		if (!parsed.success || parsed.data.instance === instance) return;
		const message = parsed.data;
		if (message.kind === "gone") {
			liveOwners.delete(message.id);
			return;
		}
		if (message.kind === "present" && message.id === draftOwner()) {
			windowOwner = randomId();
			sessionStorage.setItem("mainworthy:draft-window", windowOwner);
		}
		liveOwners.add(message.id);
		if (message.kind === "hello") send("present");
	};
	window.addEventListener("pagehide", () => send("gone"));
	window.addEventListener("pageshow", () => send("hello"));
	send("hello");
	await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
}
