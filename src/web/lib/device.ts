// What this browser keeps for a person until the server has it: drafts, the step ids a case has used, and the
// notes typed for a run. Every key names the person signed in. Somebody else who signs in on the same browser is
// never shown what the person before them typed, and cannot record it as their own; it stays where it is for
// when that person signs in again. Work started as one person (a pending save, a retry, clean-up) carries the
// session it started in (`DeviceSession`) and stops when the page's person changes, in this tab or another.
let person = "";
let revision = 0;
let active = false;
export const sessionPersonKey = "casebook:session-person";
export type DeviceSession = { person: string; revision: number };

export function setDevicePerson(actor: string): void {
	if (!active || actor !== person) revision++;
	person = actor;
	active = true;
	try {
		localStorage.setItem(sessionPersonKey, actor);
	} catch {}
}
export function suspendDeviceSession(): void {
	active = false;
	revision++;
}
export const deviceSession = (): DeviceSession => ({ person, revision });
export const sessionCurrent = (owner: DeviceSession): boolean =>
	active && owner.person === person && owner.revision === revision;
export const deviceKey = (kind: string, rest: string, actor = person): string =>
	`casebook:${encodeURIComponent(actor)}:${kind}:${rest}`;
