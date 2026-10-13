// The project was called Casebook until 2026-10-13 (decision 0014). A browser that used it then holds drafts,
// run notes and the chosen theme under keys that start with `casebook:`. This module moves them to the new
// prefix once, before anything reads them: `main.tsx` imports it first.
const FORMER = "casebook:";
const CURRENT = "mainworthy:";

type KeyStore = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

/** Renames every former key. A key that already exists under the new name wins, and the former one is dropped. */
export function adoptFormerKeys(store: KeyStore): void {
	const former: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const key = store.key(i);
		if (key?.startsWith(FORMER)) former.push(key);
	}
	for (const key of former) {
		const value = store.getItem(key);
		const current = CURRENT + key.slice(FORMER.length);
		if (value !== null && store.getItem(current) === null) store.setItem(current, value);
		store.removeItem(key);
	}
}

for (const store of [() => localStorage, () => sessionStorage]) {
	try {
		adoptFormerKeys(store());
	} catch {
		// No storage (a private window, a test outside a browser): nothing was kept, so nothing moves.
	}
}
