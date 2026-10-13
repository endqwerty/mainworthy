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
export async function initializeDraftOwners(): Promise<void> {
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
