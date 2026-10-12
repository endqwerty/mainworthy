// What this browser keeps for a person until the server has it: drafts, the step ids a case has used, and the
// notes typed for a run. Every key names the person signed in. Somebody else who signs in on the same browser is
// never shown what the person before them typed, and cannot record it as their own; it stays where it is for
// when that person signs in again.
let person = "";

/** Set as soon as the session is known, before anything is read or written. */
export function setDevicePerson(actor: string): void {
	person = actor;
}

/** The storage key of one kind of thing (`draft`, `active`, `steps`, `run-note`) for the person signed in. */
export const deviceKey = (kind: string, rest: string): string =>
	`casebook:${encodeURIComponent(person)}:${kind}:${rest}`;
