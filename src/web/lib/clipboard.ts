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

/**
 * Copies text that is no secret. Where the page has no `navigator.clipboard` (plain http, as above), a field
 * outside the view holds the text for one synchronous copy. It answers whether the copy was made.
 */
export async function copyText(text: string): Promise<boolean> {
	if (navigator.clipboard) {
		return navigator.clipboard.writeText(text).then(
			() => true,
			() => false,
		);
	}
	const field = document.createElement("textarea");
	const focused = document.activeElement;
	field.value = text;
	field.setAttribute("readonly", "");
	field.style.position = "fixed";
	field.style.top = "-1000px";
	document.body.append(field);
	try {
		field.select();
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		field.remove();
		if (focused instanceof HTMLElement) focused.focus();
	}
}
