import { z } from "zod";
import { type DeviceSession, deviceKey, deviceSession, sessionCurrent } from "./device.ts";
import { claimDraft, Draft, draftKey, draftTags, hasTypedMerge, readDraft, writeDraft } from "./drafts.ts";
import { draftOwner, randomId } from "./ids.ts";

export type DraftCopy = { key: string; draft: Draft; stored: boolean };
const Copy = z.object({ draft: Draft, state: z.enum(["writing", "waiting", "lost"]) });
type Copy = z.infer<typeof Copy>;
type Pending = { key: string; copy: Copy; ready: boolean; owner: DeviceSession };
const unstored = new Map<string, { copy: Copy; owner: DeviceSession }>();
const pending = new Map<string, Pending>();
const confirmed = new Map<string, DeviceSession>();
export const draftCopiesChanged = "mainworthy:draft-copies";
export const draftCopyPrefix = ({ project, id }: { project: string; id: string }): string =>
	deviceKey("draft-copy", `${encodeURIComponent(project)}:${encodeURIComponent(id)}:`);
const content = (draft: Draft): string => JSON.stringify([draft.body, draftTags(draft), draft.covers, draft.folder]);
function matches(copy: Draft, other: Draft): boolean {
	return (
		content(copy) === content(other) && JSON.stringify(copy.conflict?.merged) === JSON.stringify(other.conflict?.merged)
	);
}
function store(key: string, copy: Copy): boolean {
	try {
		localStorage.setItem(key, JSON.stringify(copy));
		unstored.delete(key);
		return true;
	} catch {
		unstored.set(key, { copy, owner: deviceSession() });
		return false;
	}
}
function copies(scope: { project: string; id: string }): Map<string, Copy> {
	const found = new Map<string, Copy>();
	const start = draftCopyPrefix(scope);
	try {
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index);
			if (!key?.startsWith(start)) continue;
			try {
				const parsed = Copy.safeParse(JSON.parse(localStorage.getItem(key) ?? "null"));
				if (!parsed.success || parsed.data.draft.id !== scope.id) continue;
				const copy = parsed.data;
				// This window's synchronous write cannot still be running when it reads copies, including after reload.
				if (copy.state === "writing" && copy.draft.owner === draftOwner()) {
					copy.state = "lost";
					store(key, copy);
				}
				found.set(key, copy);
			} catch {}
		}
	} catch {}
	for (const [key, held] of unstored) {
		if (!sessionCurrent(held.owner)) unstored.delete(key);
		else if (key.startsWith(start)) found.set(key, held.copy);
	}
	return found;
}
function notify(): void {
	if (typeof window !== "undefined") window.dispatchEvent(new Event(draftCopiesChanged));
}
function settle(scope: { project: string; id: string }, found: Map<string, Copy>, current: Draft | null): void {
	const shared = draftKey(scope);
	const held = pending.get(shared);
	if (!held?.ready || !sessionCurrent(held.owner)) return;
	if (!found.has(held.key)) {
		pending.delete(shared);
		return;
	}
	if (current?.owner === draftOwner()) {
		// A first writer publishes its copy before its guarded ownership read. Wait for any such write still
		// in progress, including a window paused between that read and its shared write (issue #196).
		if ([...found.values()].some((copy) => copy.state === "writing")) return;
		confirmed.set(shared, held.owner);
	} else {
		confirmed.delete(shared);
		if (!current || !matches(held.copy.draft, current)) {
			pending.delete(shared);
			if (current) {
				const lost: Copy = { draft: held.copy.draft, state: "lost" };
				store(held.key, lost);
				found.set(held.key, lost);
			}
			return;
		}
	}
	pending.delete(shared);
	discardDraftCopy(held.key);
	found.delete(held.key);
}

function protectDraft(scope: { project: string; draft: Draft }, write: () => Draft | null): Draft | null {
	const { project, draft } = scope;
	if (!draft.dirty) return write();
	const shared = draftKey({ project, id: draft.id });
	const prior = pending.get(shared);
	const previous = prior && sessionCurrent(prior.owner) ? prior : undefined;
	const held: Pending = previous ?? {
		key: `${draftCopyPrefix({ project, id: draft.id })}${draftOwner()}:${randomId()}`,
		copy: { draft: { ...draft, owner: draftOwner() }, state: "writing" },
		ready: false,
		owner: deviceSession(),
	};
	store(held.key, { draft: { ...draft, owner: draftOwner() }, state: "writing" });
	let accepted: Draft;
	try {
		const written = write();
		if (!written) {
			if (previous) store(held.key, previous.copy);
			else discardDraftCopy(held.key);
			return null;
		}
		accepted = written;
	} catch (error) {
		held.copy = { draft: { ...draft, owner: draftOwner() }, state: "waiting" };
		held.ready = true;
		if (!store(held.key, held.copy)) {
			try {
				localStorage.removeItem(held.key);
			} catch {}
		}
		pending.set(shared, held);
		notify();
		throw error;
	}
	held.copy = { draft: accepted, state: "waiting" };
	store(held.key, held.copy);
	pending.set(shared, held);
	if (!previous) {
		const owner = held.owner;
		setTimeout(() => {
			if (!sessionCurrent(owner) || pending.get(shared) !== held) return;
			held.ready = true;
			const scope = { project, id: draft.id };
			const found = copies(scope);
			settle(scope, found, readDraft(scope));
			notify();
		}, 0);
	}
	return accepted;
}

/** Only the uncertain first writes need a second copy. Confirmed editing uses the original write path. */
export function writeCopiedDraft(scope: { project: string; draft: Draft }): boolean {
	const shared = draftKey({ project: scope.project, id: scope.draft.id });
	const owner = confirmed.get(shared);
	if (owner && sessionCurrent(owner)) {
		const written = writeDraft(scope);
		if (!written) confirmed.delete(shared);
		return written;
	}
	if (scope.draft.owner !== draftOwner()) return writeDraft(scope);
	return protectDraft(scope, () => (writeDraft(scope) ? scope.draft : null)) !== null;
}

/** A handoff carries the stored text forward. It is not a competing first write. */
export function claimCopiedDraft(scope: Parameters<typeof claimDraft>[0]): Draft {
	const current = readDraft({ project: scope.project, id: scope.draft.id });
	const shared = draftKey({ project: scope.project, id: scope.draft.id });
	pending.delete(shared);
	confirmed.delete(shared);
	let claimed = scope.draft;
	protectDraft({ project: scope.project, draft: current ?? scope.draft }, () => {
		claimed = claimDraft(scope);
		return claimed.owner === draftOwner() ? claimed : null;
	});
	if (current && claimed.owner === draftOwner()) {
		const kept = pending.get(shared)?.key;
		for (const [key, copy] of copies({ project: scope.project, id: claimed.id })) {
			if (key === kept || copy.state === "writing") continue;
			if (matches(copy.draft, current)) discardDraftCopy(key);
			else if (copy.draft.owner !== current.owner && copy.state !== "lost") store(key, { ...copy, state: "lost" });
		}
		notify();
	}
	return claimed;
}

export function readDraftCopies(scope: { project: string; id: string; recorded?: Draft }): DraftCopy[] {
	const found = copies(scope);
	const current = readDraft(scope);
	settle(scope, found, current);
	return [...found].flatMap(([key, copy]) => {
		if (copy.state === "writing" || !copy.draft.dirty) return [];
		if (
			(current && current.owner !== copy.draft.owner && matches(copy.draft, current)) ||
			(scope.recorded &&
				scope.recorded.base > copy.draft.base &&
				content(copy.draft) === content(scope.recorded) &&
				(!copy.draft.conflict ||
					!hasTypedMerge(copy.draft.conflict) ||
					JSON.stringify(copy.draft.conflict.merged) === JSON.stringify(scope.recorded.body)))
		) {
			discardDraftCopy(key);
			return [];
		}
		if (copy.state !== "lost") {
			if (!current || current.owner === copy.draft.owner) return [];
			store(key, { ...copy, state: "lost" });
		}
		return [{ key, draft: copy.draft, stored: !unstored.has(key) }];
	});
}
export function forgetDraftCopy({ project, draft }: { project: string; draft: Draft }): void {
	const shared = draftKey({ project, id: draft.id });
	const held = pending.get(shared);
	if (held) discardDraftCopy(held.key);
	pending.delete(shared);
	confirmed.delete(shared);
}
export function discardDraftCopy(key: string): void {
	unstored.delete(key);
	try {
		localStorage.removeItem(key);
	} catch {}
}
