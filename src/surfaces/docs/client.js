// The documentation site's script: the theme, the search, the copy buttons and the page list on a narrow screen.
// It is served as it is written (no build step), and every page works without it: this adds, it does not render.

// The theme is the app's: the same key in the same storage, so the docs open the way the app was left.
const THEME_KEY = "mainworthy:theme";
const stored = () => {
	try {
		const value = localStorage.getItem(THEME_KEY);
		return value === "light" || value === "dark" ? value : null;
	} catch {
		return null;
	}
};
const system = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
// Before the page is drawn, so it is never drawn in the other theme first.
document.documentElement.dataset.theme = stored() ?? system();

/**
 * A diagram follows the system by itself. When the reader chose a theme here, it is told which. The frame is
 * put in again with its new address: one that has not loaded yet (it loads when scrolled to) keeps the address it
 * was written with when only its `src` is changed.
 */
function themeDiagrams(theme) {
	for (const frame of document.querySelectorAll(".diagram iframe")) {
		const url = new URL(frame.src);
		if (url.searchParams.get("theme") === theme) continue;
		url.searchParams.set("theme", theme);
		const fresh = frame.cloneNode(false);
		fresh.src = url.href;
		frame.replaceWith(fresh);
	}
}

function setUpTheme() {
	// Only when the choice is not the system's: a diagram already draws itself in the system's theme.
	const chosen = stored();
	if (chosen && chosen !== system()) themeDiagrams(chosen);
	document.querySelector(".theme")?.addEventListener("click", () => {
		const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {}
		document.documentElement.dataset.theme = next;
		themeDiagrams(next);
	});
	matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (!stored()) document.documentElement.dataset.theme = system();
	});
}

function setUpCopy() {
	if (!navigator.clipboard) return;
	for (const block of document.querySelectorAll("article pre")) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy";
		button.textContent = "Copy";
		button.addEventListener("click", async () => {
			// What is copied is what is typed: the lines that start with a prompt, without it, when there are any.
			const lines = (block.querySelector("code")?.textContent ?? "").split("\n");
			const commands = lines.filter((line) => line.startsWith("$ ")).map((line) => line.slice(2));
			await navigator.clipboard.writeText((commands.length > 0 ? commands : lines).join("\n").trim());
			button.textContent = "Copied";
			setTimeout(() => {
				button.textContent = "Copy";
			}, 1500);
		});
		block.append(button);
	}
}

function setUpMenu() {
	const menu = document.querySelector(".menu");
	menu?.addEventListener("click", () => {
		const open = document.body.classList.toggle("pages-open");
		menu.setAttribute("aria-expanded", String(open));
	});
}

/** Marks, in the list of headings, the one the reader is at. */
function setUpContents() {
	const links = new Map(
		[...document.querySelectorAll(".toc a")].map((link) => [decodeURIComponent(link.hash.slice(1)), link]),
	);
	if (links.size === 0 || !("IntersectionObserver" in window)) return;
	const seen = new Set();
	const observer = new IntersectionObserver(
		(changes) => {
			for (const change of changes) {
				if (change.isIntersecting) seen.add(change.target.id);
				else seen.delete(change.target.id);
			}
			const first = [...links.keys()].find((id) => seen.has(id));
			if (!first) return;
			for (const [id, link] of links) link.classList.toggle("here", id === first);
		},
		{ rootMargin: "-60px 0px -60% 0px" },
	);
	for (const id of links.keys()) {
		const heading = document.getElementById(id);
		if (heading) observer.observe(heading);
	}
}

/** How well one line of the index answers the words typed. Every word must be somewhere in it; 0 when one is not. */
function score(entry, words) {
	const heading = (entry.heading ?? "").toLowerCase();
	const page = entry.page.toLowerCase();
	const text = entry.text.toLowerCase();
	let total = 0;
	for (const word of words) {
		const points = (heading.includes(word) ? 10 : 0) + (page.includes(word) ? 6 : 0) + (text.includes(word) ? 1 : 0);
		if (points === 0) return 0;
		total += points;
	}
	// The top of a page before a heading inside it, when both say the word.
	return total + (entry.heading === null ? 2 : 0);
}

/** The words around the first match, with each match marked. */
function excerpt(text, words) {
	const lower = text.toLowerCase();
	const at = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0), text.length);
	const from = Math.max(0, (at === text.length ? 0 : at) - 50);
	const piece = `${from > 0 ? "…" : ""}${text.slice(from, from + 170)}`;
	const node = document.createElement("div");
	node.className = "words";
	const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
	for (const part of piece.split(pattern)) {
		if (!part) continue;
		if (words.includes(part.toLowerCase())) {
			const mark = document.createElement("mark");
			mark.textContent = part;
			node.append(mark);
		} else node.append(part);
	}
	return node;
}

function setUpSearch() {
	const input = document.getElementById("search");
	const list = document.getElementById("search-results");
	if (!(input instanceof HTMLInputElement) || !list) return;
	let index = null;
	let cursor = 0;
	const load = async () => {
		index ??= fetch("/docs/search.json").then((response) => response.json());
		return index;
	};
	const select = (to) => {
		const items = [...list.querySelectorAll("a")];
		if (items.length === 0) return;
		cursor = Math.max(0, Math.min(items.length - 1, to));
		items.forEach((item, at) => {
			item.setAttribute("aria-selected", String(at === cursor));
		});
		items[cursor]?.scrollIntoView({ block: "nearest" });
	};
	const close = () => {
		list.hidden = true;
		list.replaceChildren();
	};
	const show = async () => {
		const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
		if (words.length === 0) return close();
		const entries = await load();
		const found = entries
			.map((entry) => ({ entry, points: score(entry, words) }))
			.filter((item) => item.points > 0)
			.sort((a, b) => b.points - a.points)
			.slice(0, 12);
		list.replaceChildren();
		for (const { entry } of found) {
			const link = document.createElement("a");
			link.href = entry.url;
			link.setAttribute("role", "option");
			const where = document.createElement("div");
			where.className = "where";
			where.textContent = entry.heading ? `${entry.section} › ${entry.page}` : entry.section;
			const what = document.createElement("div");
			what.className = "what";
			what.textContent = entry.heading ?? entry.page;
			link.append(where, what, excerpt(entry.text, words));
			list.append(link);
		}
		if (found.length === 0) {
			const none = document.createElement("div");
			none.className = "none";
			none.textContent = "Nothing in the docs has all of those words.";
			list.append(none);
		}
		list.hidden = false;
		select(0);
	};
	input.addEventListener("focus", () => void load());
	input.addEventListener("input", () => void show());
	input.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			select(cursor + (event.key === "ArrowDown" ? 1 : -1));
		} else if (event.key === "Enter") {
			const chosen = list.querySelectorAll("a")[cursor];
			if (chosen instanceof HTMLAnchorElement) location.href = chosen.href;
		} else if (event.key === "Escape") {
			input.value = "";
			close();
			input.blur();
		}
	});
	document.addEventListener("click", (event) => {
		if (event.target instanceof Node && !input.parentElement?.contains(event.target)) close();
	});
	document.addEventListener("keydown", (event) => {
		const typing = event.target instanceof HTMLElement && event.target.matches("input,textarea,select");
		if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
			event.preventDefault();
			input.focus();
		}
	});
}

document.addEventListener("DOMContentLoaded", () => {
	setUpTheme();
	setUpCopy();
	setUpMenu();
	setUpContents();
	setUpSearch();
});
