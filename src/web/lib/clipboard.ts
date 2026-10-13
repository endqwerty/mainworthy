/**
 * Copies a secret that is shown once, in a masked field: an invitation's link. It answers whether the copy was
 * made.
 *
 * A page opened over plain http at a name that is not this machine's has no `navigator.clipboard`. There the
 * field is unmasked for the length of one synchronous copy, before the browser paints, and masked again.
 * (The new token in Settings copies the same way, with the same steps written out where it is shown.)
 */
export async function copySecret(field: HTMLInputElement | null, text: string): Promise<boolean> {
	if (navigator.clipboard) {
		return navigator.clipboard.writeText(text).then(
			() => true,
			() => false,
		);
	}
	if (!field) return false;
	const focused = document.activeElement;
	try {
		field.type = "text";
		field.select();
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		field.type = "password";
		if (focused instanceof HTMLElement) focused.focus();
	}
}
