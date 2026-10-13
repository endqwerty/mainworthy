import { useSyncExternalStore } from "react";

/**
 * A phone, or a tablet held upright: the first pointer is a finger, and the window is too narrow or too low for
 * the three columns. A browser worked with a mouse never matches, however narrow its window, so nothing written
 * for the phone reaches the desktop (decision 0018). The one place that says what a phone is: the styles read
 * `data-layout="phone"` on the root element, and the shell reads `usePhone`.
 */
export const PHONE = "(pointer: coarse) and (max-width: 900px), (pointer: coarse) and (max-height: 500px)";

const media = matchMedia(PHONE);
function mark(): void {
	if (media.matches) document.documentElement.dataset.layout = "phone";
	else delete document.documentElement.dataset.layout;
}
mark();
media.addEventListener("change", mark);

function subscribe(listener: () => void): () => void {
	media.addEventListener("change", listener);
	return () => media.removeEventListener("change", listener);
}
export function usePhone(): boolean {
	return useSyncExternalStore(subscribe, () => media.matches);
}
