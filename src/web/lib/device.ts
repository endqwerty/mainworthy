// What this browser keeps for a person until the server has it: drafts, the step ids a case has used, and the
// notes typed for a run. Every key names the person signed in. Somebody else who signs in on the same browser is
// never shown what the person before them typed, and cannot record it as their own. Sign-out can explicitly
// clear it; otherwise it stays for when that person signs in again. Work started as one person (a pending
// save, a retry, clean-up) carries the session it started in (`DeviceSession`) and stops when the page's person
// changes or the browser data is cleared, in this tab or another.
let person = "";
let revision = 0;
let active = false;
export const deviceClearKey = "mainworthy:device-clear";
function clearRevision(): string {
	try {
		return localStorage.getItem(deviceClearKey) ?? "";
	} catch {
		return "";
	}
}
let cleared = clearRevision();
export const sessionPersonKey = "mainworthy:session-person";
export type DeviceSession = { person: string; revision: number; cleared: string };

export function setDevicePerson(actor: string): void {
	if (!active || actor !== person) revision++;
	person = actor;
	cleared = clearRevision();
	active = true;
	try {
		localStorage.setItem(sessionPersonKey, actor);
	} catch {}
}
export function suspendDeviceSession(): void {
	active = false;
	cleared = clearRevision();
	revision++;
}
export const deviceSession = (): DeviceSession => ({ person, revision, cleared });
export const sessionUnchanged = (owner: DeviceSession): boolean =>
	owner.person === person && owner.revision === revision && owner.cleared === clearRevision();
export const sessionCurrent = (owner: DeviceSession): boolean => active && sessionUnchanged(owner);

/** Invalidate old work before deleting, so other tabs and delayed replies cannot put cleared drafts back. */
export function clearDevicePerson(owner: DeviceSession): void {
	localStorage.setItem(deviceClearKey, String(crypto.getRandomValues(new Uint32Array(4))));
	suspendDeviceSession();
	if (localStorage.getItem(sessionPersonKey) === owner.person) localStorage.removeItem(sessionPersonKey);
	const prefix = personPrefix(owner.person);
	for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
}
const personPrefix = (actor: string): string => `mainworthy:${encodeURIComponent(actor)}:`;
export const deviceKey = (kind: string, rest: string, actor = person): string =>
	`${personPrefix(actor)}${kind}:${rest}`;
