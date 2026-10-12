import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { SessionInfo } from "../core/api.ts";
import { CaseScreen } from "./case/index.tsx";
import { ChangesScreen } from "./changes/index.tsx";
import { ApiError, login, session, unauthenticatedEvent } from "./lib/api.ts";
import { queryClient, useEvents, useQueryOp } from "./lib/data.ts";
import { deviceSession, sessionPersonKey, setDevicePerson, suspendDeviceSession } from "./lib/device.ts";
import { useBindings, useKeyboard, useKeyRegistry } from "./lib/keys.ts";
import { navigate, refUrl, routeUrl, type Screen, useRoute } from "./lib/router.ts";
import { QueueScreen } from "./queue/index.tsx";
import { RunsScreen } from "./runs/index.tsx";
import { SettingsScreen } from "./settings/index.tsx";
import { SuiteScreen } from "./suite/index.tsx";
import { AppContext, type PaletteOptions } from "./ui/context.tsx";
import { KeyCap, ProducerGlyph, StatusLine } from "./ui/index.tsx";

const screens = {
	suite: SuiteScreen,
	case: CaseScreen,
	queue: QueueScreen,
	runs: RunsScreen,
	changes: ChangesScreen,
	settings: SettingsScreen,
} satisfies Record<Screen, typeof SuiteScreen>;
const navigation: { screen: Screen; label: string; icon: string; key: string }[] = [
	{ screen: "suite", label: "Suite", icon: "▤", key: "g s" },
	{ screen: "queue", label: "Queue", icon: "◎", key: "g q" },
	{ screen: "runs", label: "Runs", icon: "▷", key: "g r" },
	{ screen: "changes", label: "Changes", icon: "↗", key: "g c" },
	{ screen: "settings", label: "Settings", icon: "⚙︎", key: "g ," },
];
function theme(): void {
	const chosen = localStorage.getItem("casebook:theme");
	document.documentElement.dataset.theme =
		chosen ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
theme();

export function App() {
	const [auth, setAuth] = useState<
		| { kind: "loading" }
		| { kind: "signin" }
		| { kind: "ready"; session: SessionInfo }
		| { kind: "error"; message: string }
	>({ kind: "loading" });
	const person = useRef<string | null>(null);
	const refreshSession = useCallback(async (): Promise<void> => {
		try {
			const info = await session();
			// What the device keeps is kept per person. A different person from the one before starts with nothing
			// of theirs: not their drafts, not their notes, not what the app had read for them.
			if (person.current !== null && person.current !== info.actor) queryClient.clear();
			person.current = info.actor;
			setDevicePerson(info.actor);
			setAuth({ kind: "ready", session: info });
		} catch (error) {
			setAuth(
				error instanceof ApiError && error.code === "unauthenticated"
					? { kind: "signin" }
					: { kind: "error", message: error instanceof Error ? error.message : "Cannot connect to Casebook" },
			);
		}
	}, []);
	useEffect(() => {
		const refused = () => {
			suspendDeviceSession();
			queryClient.clear();
			setAuth({ kind: "signin" });
		};
		const changed = (event: StorageEvent) => {
			if (event.key === sessionPersonKey && event.newValue !== deviceSession().person) refused();
		};
		window.addEventListener("storage", changed);
		window.addEventListener(unauthenticatedEvent, refused);
		void refreshSession();
		return () => {
			window.removeEventListener(unauthenticatedEvent, refused);
			window.removeEventListener("storage", changed);
		};
	}, [refreshSession]);
	useEffect(() => {
		const media = matchMedia("(prefers-color-scheme: dark)");
		const changed = () => {
			if (!localStorage.getItem("casebook:theme")) theme();
		};
		media.addEventListener("change", changed);
		return () => media.removeEventListener("change", changed);
	}, []);
	if (auth.kind === "signin") return <SignIn onLogin={refreshSession} />;
	if (auth.kind === "error")
		return (
			<div className="signin">
				<p role="status">{auth.message}</p>
				<button type="button" onClick={() => void refreshSession()}>
					Reconnect
				</button>
			</div>
		);
	if (auth.kind === "loading")
		return (
			<div className="signin">
				<span className="brand">
					<span className="logo">C</span>
					Casebook
				</span>
			</div>
		);
	return <Workbench key={auth.session.actor} info={auth.session} refreshSession={refreshSession} />;
}
function SignIn({ onLogin }: { onLogin: () => Promise<void> }) {
	const [token, setToken] = useState("");
	const [error, setError] = useState("");
	return (
		<div className="signin">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void login(token)
						.then(onLogin)
						.catch((reason: unknown) => {
							setError(reason instanceof Error ? reason.message : "That token was not accepted");
						});
				}}
			>
				<h1>Casebook</h1>
				<label htmlFor="token">Sign in with your token</label>
				<input
					id="token"
					name="token"
					type="password"
					autoComplete="current-password"
					ref={(element) => {
						element?.focus();
					}}
					value={token}
					onChange={(event) => setToken(event.target.value)}
				/>
				<div className="error" role="status">
					{error}
				</div>
				<button type="submit">Sign in</button>
			</form>
		</div>
	);
}
function Workbench({ info, refreshSession }: { info: SessionInfo; refreshSession: () => Promise<void> }) {
	const route = useRoute();
	const project = route.project;
	const [status, setStatus] = useState(
		"Drafts stay on this device. A version is recorded when you leave, press ⌘↵, or pause for 30 seconds.",
	);
	const [palette, setPalette] = useState<PaletteOptions | null>(null);
	const paletteOrigin = useRef<HTMLElement | null>(null);
	const openPalette = useCallback((options: PaletteOptions = {}): void => {
		paletteOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setHelp(false);
		setPalette(options);
	}, []);
	const closePalette = useCallback((chosen = false): void => {
		setPalette(null);
		const origin = paletteOrigin.current;
		paletteOrigin.current = null;
		if (!chosen)
			queueMicrotask(() => {
				if (origin?.isConnected) origin.focus();
			});
	}, []);
	const [help, setHelp] = useState(false);
	const [inInput, setInInput] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const suiteOpen = route.screen === "suite" || route.screen === "case";
	useEffect(() => {
		const change = () =>
			queueMicrotask(() => {
				const node = document.activeElement;
				setInInput(node instanceof HTMLElement && (node.matches("input,textarea,select") || node.isContentEditable));
			});
		window.addEventListener("focusin", change);
		window.addEventListener("focusout", change);
		return () => {
			window.removeEventListener("focusin", change);
			window.removeEventListener("focusout", change);
		};
	}, []);
	const registry = useKeyRegistry();
	useKeyboard();
	useEvents(project);
	const folders = useQueryOp({ project, op: "find", input: { in: "folders" } });
	const tags = useQueryOp({ project, op: "find", input: { in: "tags" }, enabled: suiteOpen });
	const tagRows = useMemo(
		() => z.array(z.object({ tag: z.string(), n: z.number() })).parse(tags.data?.items ?? []),
		[tags.data],
	);
	const inbox = useQueryOp({ project, op: "inbox", input: { state: "open", limit: 1 } });
	const go = (screen: Screen) => navigate(routeUrl({ project, screen }));
	const globalKeys = useMemo(
		() => [
			{
				key: "[",
				label: "Collapse / expand sidebar",
				when: () => palette === null && !help,
				handler: () => setSidebarCollapsed((value) => !value),
			},
			...navigation.map((item) => ({
				key: item.key,
				label: `Go to ${item.label}`,
				handler: () => navigate(routeUrl({ project, screen: item.screen })),
			})),
			{
				key: "mod+k",
				label: "Jump to or run",
				handler: () => {
					setHelp(false);
					if (palette) closePalette();
					else openPalette();
				},
			},
			{
				key: "?",
				label: "All keys",
				handler: () => {
					setPalette(null);
					setHelp(true);
				},
			},
			{
				key: "escape",
				label: "Close palette / keys",
				hidden: true,
				when: () => palette !== null || help,
				handler: () => {
					closePalette();
					setHelp(false);
				},
			},
		],
		[project, palette, help, openPalette, closePalette],
	);
	useBindings(globalKeys);
	useEffect(() => {
		if (!location.pathname.startsWith("/p/")) {
			const first = info.projects[0];
			if (first) navigate(routeUrl({ project: first.key, screen: "suite" }), { replace: true });
		}
	}, [info]);
	const priorities = inInput
		? ["enter", "tab", "shift+enter", "mod+enter", "escape", "mod+k"]
		: route.screen === "suite" || route.screen === "case"
			? ["c", "e", "a", "r", "u", "/", "mod+k", "?"]
			: route.screen === "runs"
				? ["p", "f", "b", "s", "n", "u", "mod+k", "?"]
				: ["d", "t", "e", "f", "i", "n", "m", "a", "r", "l", "c", "u", "mod+k", "?"];
	const hints = registry
		.filter(
			(binding) =>
				!binding.hidden &&
				(!binding.when || binding.when()) &&
				(!inInput || binding.allowInInput || binding.key.startsWith("mod+") || binding.key === "escape"),
		)
		.filter((binding) => priorities.includes(binding.key))
		.sort((a, b) => priorities.indexOf(a.key) - priorities.indexOf(b.key))
		.slice(0, 7);
	const ScreenComponent = screens[route.screen];
	return (
		<AppContext.Provider
			value={{
				project,
				route,
				// A screen asks what the caller may do in the project it shows, not on the instance.
				session: { ...info, can: info.projects.find((entry) => entry.key === project)?.can ?? [] },
				instanceCan: info.can,
				setStatus,
				openPalette,
				refreshSession,
				overlayOpen: palette !== null || help,
			}}
		>
			<div id="app" className={sidebarCollapsed ? "sidebar-collapsed" : ""}>
				<aside id="side">
					<div className="brand">
						<button
							type="button"
							className="logo"
							aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
							onClick={() => setSidebarCollapsed((value) => !value)}
						>
							C
						</button>
						<b>Casebook</b>
						{info.projects.length > 1 ? (
							<select
								className="project-select"
								aria-label="Project"
								value={project}
								onChange={(event) => {
									event.currentTarget.blur();
									navigate(routeUrl({ project: event.target.value, screen: "suite" }));
								}}
							>
								{info.projects.map((p) => (
									<option key={p.key} value={p.key}>
										{p.name}
									</option>
								))}
							</select>
						) : (
							<span className="proj">{project}</span>
						)}
					</div>
					<button className="search" type="button" onClick={() => openPalette()}>
						<span>Jump to or run…</span>
						<KeyCap>⌘K</KeyCap>
					</button>
					<nav id="nav" aria-label="Main">
						{navigation.map((item) => (
							<a
								key={item.screen}
								aria-label={item.label}
								title={item.label}
								href={routeUrl({ project, screen: item.screen })}
								className={
									route.screen === item.screen || (item.screen === "suite" && route.screen === "case") ? "on" : ""
								}
								onClick={(event) => {
									event.preventDefault();
									go(item.screen);
								}}
							>
								<span className="ni">{item.icon}</span>
								<span className="nav-label">{item.label}</span>
								{item.screen === "suite" && <em>{folders.data?.count?.toLocaleString()}</em>}
								{item.screen === "queue" && (
									<em className={inbox.data?.counts.open ? "hot" : ""}>
										{inbox.data?.counts.open ?? Object.values(inbox.data?.counts ?? {}).reduce((a, b) => a + b, 0)}
									</em>
								)}
								<KeyCap>{item.key}</KeyCap>
							</a>
						))}
					</nav>
					{suiteOpen && (
						<div className="suite-tree">
							<div className="sech side">Folders</div>
							<div id="tree">
								<button className={`fo ${route.folder === null ? "on" : ""}`} type="button" onClick={() => go("suite")}>
									<span className="tw" />
									<span className="fn">All cases</span>
									<span className="n">{folders.data?.count ?? 0}</span>
								</button>
								{[...(folders.data?.items ?? [])]
									.sort((a, b) => String(a.path).localeCompare(String(b.path)))
									.map((folder) => {
										const path = typeof folder.path === "string" ? folder.path : "";
										const name = typeof folder.name === "string" ? folder.name : path;
										const count = (folders.data?.items ?? [])
											.filter(
												(item) =>
													item.path === path || (typeof item.path === "string" && item.path.startsWith(`${path}/`)),
											)
											.reduce((total, item) => total + (typeof item.cases === "number" ? item.cases : 0), 0);
										return (
											<button
												key={path}
												type="button"
												className={`fo ${route.folder === path ? "on" : ""}`}
												style={{ paddingLeft: `${path.split("/").length * 12}px` }}
												onClick={() => navigate(routeUrl({ project, screen: "suite", folder: path }))}
												onDragOver={(event) => event.preventDefault()}
												onDrop={(event) => {
													event.preventDefault();
													window.dispatchEvent(
														new CustomEvent("casebook:drop", {
															detail: { folder: path, ref: event.dataTransfer.getData("text/plain") },
														}),
													);
												}}
											>
												<span className="tw" />
												<span className="fn">{name}</span>
												<span className="n">{count}</span>
											</button>
										);
									})}
								<div id="folder-create" />
							</div>
							<div className="sidebar-tags">
								<div className="sech side">Tags</div>
								{new URLSearchParams(location.search).has("tag") && (
									<button
										type="button"
										className="fo"
										onClick={() => navigate(routeUrl({ project, screen: "suite", folder: route.folder }))}
									>
										All tags
									</button>
								)}
								{tagRows.map(({ tag, n }) => (
									<button
										key={tag}
										type="button"
										className={`fo ${new URLSearchParams(location.search).getAll("tag").includes(tag) ? "on" : ""}`}
										onClick={() => {
											const path = routeUrl({ project, screen: "suite", folder: route.folder });
											navigate(`${path}${route.folder ? "&" : "?"}tag=${encodeURIComponent(tag)}`);
										}}
									>
										<span className="fn">#{tag}</span>
										<span className="n">{n}</span>
									</button>
								))}
							</div>
						</div>
					)}

					<div className="sfoot">
						<span className="me">
							<ProducerGlyph kind={info.kind} />
							{info.actor}
						</span>
						<button type="button" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>
							? <span>Keys</span>
						</button>
						<button
							type="button"
							aria-label="Toggle theme"
							onClick={() => {
								const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
								localStorage.setItem("casebook:theme", next);
								theme();
							}}
						>
							◐ <span>Theme</span>
						</button>
					</div>
				</aside>
				<ScreenComponent key={project} />
				<footer id="bar">
					<StatusLine>{status}</StatusLine>
					<div id="hints">
						{hints.map((binding) => (
							<span key={binding.key}>
								<KeyCap>{binding.key.replace("mod+", "⌘")}</KeyCap>
								{binding.label}
							</span>
						))}
					</div>
				</footer>
			</div>
			{palette && <Palette project={project} options={palette} close={closePalette} />}{" "}
			{help && (
				<div className="overlay" data-overlay="help">
					<button type="button" className="overlay-backdrop" aria-label="Close keys" onClick={() => setHelp(false)} />
					<section className="help" aria-label="Keyboard shortcuts">
						<button
							className="help-close"
							type="button"
							ref={(element) => {
								element?.focus();
							}}
							onClick={() => setHelp(false)}
						>
							Close <KeyCap>Esc</KeyCap>
						</button>
						<h2>Keys</h2>
						<div className="hg">
							<section>
								<div className="sech">Current screen and navigation</div>
								{registry.map((item) => (
									<div className="hk" key={`${item.label}:${item.key}`}>
										<span>{item.label}</span>
										<KeyCap>{item.key.replace("mod+", "⌘")}</KeyCap>
									</div>
								))}
							</section>
						</div>
					</section>
				</div>
			)}
		</AppContext.Provider>
	);
}
function Palette({
	project,
	options,
	close,
}: {
	project: string;
	options: PaletteOptions;
	close: (chosen?: boolean) => void;
}) {
	const [text, setText] = useState("");
	const [cursor, setCursor] = useState(0);
	const registry = useKeyRegistry();
	const found = useQueryOp({
		project,
		op: "find",
		input: { in: "cases", text, limit: 30 },
		enabled: text.length > 0 || Boolean(options.onPickCase),
	});
	const actions =
		options.items ??
		registry
			.filter((item) => !item.hidden)
			.map((item) => ({ id: item.key, label: item.label, detail: item.key, handler: item.handler }));
	const cases =
		found.data?.items
			.filter((row) => typeof row.ref === "string" && typeof row.title === "string")
			.map((row) => {
				const ref = String(row.ref);
				return {
					id: ref,
					label: String(row.title),
					detail: ref,
					handler: () => (options.onPickCase ? options.onPickCase(ref) : navigate(refUrl({ project, ref }))),
				};
			}) ?? [];
	const jump = /^[CQR]-\d+$/i.test(text.trim())
		? [
				{
					id: "jump",
					label: `Go to ${text.toUpperCase()}`,
					detail: "↵",
					handler: () =>
						options.onPickCase
							? options.onPickCase(text.toUpperCase())
							: navigate(refUrl({ project, ref: text.toUpperCase() })),
				},
			]
		: [];
	const items = options.onPickCase
		? [...jump, ...cases]
		: [...jump, ...actions.filter((item) => !text || item.label.toLowerCase().includes(text.toLowerCase())), ...cases];
	const choose = (index: number) => {
		const item = items[index];
		if (item) {
			close(true);
			item.handler();
		}
	};
	return (
		<div className="overlay" data-overlay="palette">
			<button type="button" className="overlay-backdrop" aria-label="Close palette" onClick={() => close()} />
			<section className="pal" aria-label={options.title ?? "Command palette"}>
				<input
					className="palette-input"
					ref={(element) => {
						element?.focus();
					}}
					aria-label={options.title ?? "Jump to or run"}
					placeholder={options.title ?? "Jump to a ref, search cases, or run an action…"}
					value={text}
					onChange={(event) => {
						setText(event.target.value);
						setCursor(0);
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setCursor((old) => Math.max(0, Math.min(items.length - 1, old + (event.key === "ArrowDown" ? 1 : -1))));
						}
						if (event.key === "Enter") {
							event.preventDefault();
							if (event.repeat) return;
							choose(cursor);
						}
					}}
				/>
				<div className="palette-list" role="listbox">
					{items.map((item, index) => (
						<button
							key={item.id}
							type="button"
							role="option"
							aria-selected={cursor === index}
							className={`pi ${cursor === index ? "on" : ""}`}
							onClick={() => choose(index)}
						>
							<span className="ic">{item.id.startsWith("C-") ? "▤" : "›"}</span>
							<span className="t">{item.label}</span>
							<span className="h">{item.detail}</span>
						</button>
					))}
					{items.length === 0 && <div className="pi faint">No matches. Try a case ref or a different title.</div>}
				</div>
				<div className="palf">
					<span>
						<KeyCap>↑ ↓</KeyCap> move
					</span>
					<span>
						<KeyCap>↵</KeyCap> choose
					</span>
					<span>
						<KeyCap>Esc</KeyCap> close
					</span>
				</div>
			</section>
		</div>
	);
}
