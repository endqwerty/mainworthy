import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import type { SessionInfo } from "../core/api.ts";
import { DOC_PAGES, type DocSlug, docUrl, SCREEN_DOCS } from "../core/docs.ts";
import { waiting, waitingPhrase } from "../core/stakes.ts";
import { CaseScreen } from "./case/index.tsx";
import { ChangesScreen } from "./changes/index.tsx";
import { ApiError, session, signedOut, unauthenticatedEvent } from "./lib/api.ts";
import { queryClient, useEvents, useQueryOp } from "./lib/data.ts";
import {
	deviceClearKey,
	deviceSession,
	sessionCurrent,
	sessionPersonKey,
	sessionUnchanged,
	setDevicePerson,
	suspendDeviceSession,
} from "./lib/device.ts";
import { resolveHome } from "./lib/home.ts";
import { useBindings, useKeyboard, useKeyRegistry } from "./lib/keys.ts";
import {
	navigate,
	navigationToken,
	projectUrl,
	readRoute,
	refUrl,
	routeUrl,
	type Screen,
	useRoute,
} from "./lib/router.ts";
import { signOut } from "./lib/signin.ts";
import { PhoneBar, usePhoneShell } from "./phone.tsx";
import { QueueScreen } from "./queue/index.tsx";
import { ReportsScreen } from "./reports/index.tsx";
import { RunsScreen } from "./runs/index.tsx";
import { SettingsScreen } from "./settings/index.tsx";
import { SignIn } from "./signin/index.tsx";
import { INVITE_PATH, Invitation } from "./signin/invite.tsx";
import { MailEntry } from "./signin/mail.tsx";
import { OIDC_PATH, OidcReturn } from "./signin/oidc.tsx";
import { SuiteScreen } from "./suite/index.tsx";
import { TestsScreen } from "./tests/index.tsx";
import { AppContext, type PaletteItem, type PaletteOptions } from "./ui/context.tsx";
import { DocLink, KeyCap, openDocs, ProducerGlyph, StatusLine } from "./ui/index.tsx";

const missingHomeStatus = "Your home was not found. Opened Suite.";

const screens = {
	suite: SuiteScreen,
	case: CaseScreen,
	queue: QueueScreen,
	runs: RunsScreen,
	changes: ChangesScreen,
	tests: TestsScreen,
	reports: ReportsScreen,
	settings: SettingsScreen,
} satisfies Record<Screen, typeof SuiteScreen>;
type Place = { screen: Screen; label: string; icon: string; key: string };
/** Where the work is done: the sidebar's navigation. */
const navigation: Place[] = [
	{ screen: "suite", label: "Suite", icon: "▤", key: "g s" },
	{ screen: "queue", label: "Queue", icon: "◎", key: "g q" },
	{ screen: "runs", label: "Runs", icon: "▷", key: "g r" },
	{ screen: "changes", label: "Changes", icon: "↗", key: "g c" },
	{ screen: "tests", label: "Tests", icon: "≡", key: "g t" },
	{ screen: "reports", label: "Reports", icon: "%", key: "g o" },
];
/** Not a place of the work, so not in the navigation: it is in the sidebar's footer, beside who is signed in. */
const settings: Place = { screen: "settings", label: "Settings", icon: "⚙︎", key: "g ," };
/** The page of the documentation that explains each screen. A screen added to the router must be named here. */
const screenDocs: Record<Screen, DocSlug> = SCREEN_DOCS;
/** The gate and its check from `icon.svg`, drawn in the colour of the square they sit in. */
function Mark() {
	return (
		<svg
			viewBox="0 0 64 64"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M13 50V17H51V50" />
			<path d="M23 36L30 43L42 28" />
		</svg>
	);
}
/** The sidebar's button: a window with its left column drawn in. */
function SidebarIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			width="16"
			height="16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinejoin="round"
		>
			<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
			<path d="M6 2.75V13.25" />
		</svg>
	);
}
/**
 * What a project is called on the page: its name, or its key where the name shows nothing. The server takes a
 * name of spaces, or of characters that have no glyph, and a line or a row with nothing on it names no project.
 */
const projectLabel = (entry: { key: string; name: string }): string =>
	/[^\s\p{Cf}]/u.test(entry.name) ? entry.name : entry.key;
/** The first letter of a name as it is read: a flag or a family is one, though it is several code points. */
const initial = (name: string): string =>
	[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)][0]?.segment ?? "";
/**
 * Where the browser keeps that the sidebar is collapsed. With the sidebar open, nothing is kept. A browser can
 * refuse its store (it is full, or switched off for the site): the sidebar then collapses and opens for the page
 * that is open. A reload uses the choice the store holds if it can be read, and opens the sidebar if it cannot.
 */
const SIDEBAR_KEY = "mainworthy:sidebar";
function sidebarKept(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
	} catch {
		return false;
	}
}
function keepSidebar(collapsed: boolean): void {
	try {
		if (collapsed) localStorage.setItem(SIDEBAR_KEY, "collapsed");
		else localStorage.removeItem(SIDEBAR_KEY);
	} catch {
		// Not kept: the page goes on with the choice it was given.
	}
}
function theme(): void {
	const chosen = localStorage.getItem("mainworthy:theme");
	document.documentElement.dataset.theme =
		chosen ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
theme();

/**
 * Focuses an element once, when it is put on the page. A ref written inline is a new function on every render, and
 * React calls each new one, so an element that focused itself that way took the focus back on every render.
 */
const focusOnce = (node: HTMLElement | null): void => node?.focus();

export function App() {
	const [auth, setAuth] = useState<
		| { kind: "loading" }
		| { kind: "signin" }
		| { kind: "ready"; session: SessionInfo; homeStatus: string | null }
		| { kind: "error"; message: string }
	>({ kind: "loading" });
	const [inviting, setInviting] = useState(() => location.pathname === INVITE_PATH);
	const [mailEntry, setMailEntry] = useState(() => location.pathname === "/reset" || location.pathname === "/email");
	const [returning, setReturning] = useState(() => location.pathname === OIDC_PATH);
	const person = useRef<number | null>(null);
	const refreshSession = useCallback(async (): Promise<void> => {
		const owner = deviceSession();
		try {
			const info = await session().catch(async (error: unknown) => {
				if (
					error instanceof ApiError &&
					error.code === "unauthenticated" &&
					error.status === null &&
					sessionUnchanged(owner)
				) {
					const current = await session();
					if (person.current !== null && current.actorId !== person.current) {
						signedOut();
						throw error;
					}
					return current;
				}
				throw error;
			});
			if (!sessionUnchanged(owner)) return;
			// What the device keeps is kept per actor, by id: a name can be given to somebody else later. A different
			// person from the one before starts with nothing of theirs: not their drafts, not their notes, not what
			// the app had read for them.
			if (person.current !== null && person.current !== info.actorId) queryClient.clear();
			person.current = info.actorId;
			setDevicePerson(info);
			// This is still the entry address, before the shell mounts. Keep it an initial visit so Suite restores drafts.
			const address = location.href;
			const requested = readRoute().project;
			const entryProject = location.search
				? undefined
				: location.pathname === "/"
					? info.projects[0]
					: /^\/p\/[^/]+\/?$/.test(location.pathname)
						? info.projects.find((entry) => entry.key === requested)
						: undefined;
			let homeStatus: string | null = null;
			if (entryProject) {
				const owner = deviceSession();
				const home = await resolveHome(entryProject.key).catch((error: unknown) => {
					if (error instanceof ApiError && error.code === "unauthenticated") throw error;
					if (location.href === address) homeStatus = "Could not read your home. Opened Suite.";
					return { url: routeUrl({ project: entryProject.key, screen: "suite" }), missing: false };
				});
				if (!sessionCurrent(owner)) return;
				if (location.href === address) {
					history.replaceState(null, "", home.url);
					if (home.missing) homeStatus = missingHomeStatus;
				}
			} else if (
				!location.pathname.startsWith("/p/") &&
				![INVITE_PATH, OIDC_PATH, "/reset", "/email"].includes(location.pathname)
			) {
				const first = info.projects[0];
				if (first) history.replaceState(null, "", routeUrl({ project: first.key, screen: "suite" }));
			}
			setAuth({ kind: "ready", session: info, homeStatus });
		} catch (error) {
			if (!sessionUnchanged(owner)) return;
			if (error instanceof ApiError && error.code === "unauthenticated" && error.status === null) {
				setAuth((current) =>
					current.kind === "ready"
						? current
						: { kind: "error", message: "Your session changed. Reconnect to continue." },
				);
				return;
			}
			setAuth(
				error instanceof ApiError && error.code === "unauthenticated"
					? { kind: "signin" }
					: { kind: "error", message: error instanceof Error ? error.message : "Cannot connect to Mainworthy" },
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
			if (
				(event.key === deviceClearKey && !sessionUnchanged(deviceSession())) ||
				(event.key === sessionPersonKey && localStorage.getItem(sessionPersonKey) !== String(deviceSession().actorId))
			)
				refused();
		};
		window.addEventListener("storage", changed);
		window.addEventListener(unauthenticatedEvent, refused);
		if (!sessionUnchanged(deviceSession())) refused();
		// On the way back from the identity provider the sign-in is in flight: a look at the session now can
		// be refused before it lands, and its late refusal would sign the page out of the session just made.
		// `OidcReturn` is done first, and this look comes with `returning` ending.
		if (!returning) void refreshSession();
		return () => {
			window.removeEventListener(unauthenticatedEvent, refused);
			window.removeEventListener("storage", changed);
		};
	}, [refreshSession, returning]);
	useEffect(() => {
		const media = matchMedia("(prefers-color-scheme: dark)");
		const changed = () => {
			if (!localStorage.getItem("mainworthy:theme")) theme();
		};
		media.addEventListener("change", changed);
		return () => media.removeEventListener("change", changed);
	}, []);
	// The page of an invitation is shown whoever is or is not signed in: it is how somebody gets in at all, and
	// a browser signed in as another person is asked there before anything is replaced.
	if (mailEntry)
		return (
			<MailEntry
				onDone={async () => {
					history.replaceState(null, "", "/");
					await refreshSession();
					setMailEntry(false);
				}}
			/>
		);
	// The identity provider sent the browser back: its answer is handed to the server before anything else.
	if (returning)
		return (
			<OidcReturn
				onDone={(to) => {
					// Settings opens at the section the person linked the provider from (`settingsSection`).
					history.replaceState(to.section ? { settingsSection: to.section } : null, "", to.path);
					setReturning(false);
				}}
			/>
		);
	if (inviting)
		return (
			<Invitation
				holder={
					auth.kind === "ready"
						? { kind: "known", name: auth.session.actor }
						: auth.kind === "signin"
							? { kind: "known", name: null }
							: // Still being asked, or the asking failed. Neither means that nobody is signed in.
								{ kind: auth.kind === "error" ? "failed" : "asking" }
				}
				askAgain={refreshSession}
				onDone={async () => {
					// The address first, so the app opens at its start and not at the invitation's path. The page
					// stays until the session is read, so nobody sees the app as the person signed in before.
					history.replaceState(null, "", "/");
					await refreshSession();
					setInviting(false);
				}}
			/>
		);
	if (auth.kind === "signin") return <SignIn onSignedIn={refreshSession} />;
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
					<span className="logo">
						<Mark />
					</span>
					Mainworthy
				</span>
			</div>
		);
	return (
		<Workbench
			key={auth.session.actor}
			info={auth.session}
			initialStatus={auth.homeStatus}
			refreshSession={refreshSession}
		/>
	);
}
function Workbench({
	info,
	initialStatus,
	refreshSession,
}: {
	info: SessionInfo;
	initialStatus: string | null;
	refreshSession: () => Promise<void>;
}) {
	const route = useRoute();
	const project = route.project;
	const [status, setStatus] = useState(
		initialStatus ??
			"Drafts stay on this device. A version is recorded when you leave, press ⌘↵, or pause for 30 seconds.",
	);
	const [palette, setPalette] = useState<PaletteOptions | null>(null);
	// Counts the openings. A choice in the palette may open it again (a second case to link, the projects), and
	// each opening starts with nothing typed.
	const [paletteOpening, setPaletteOpening] = useState(0);
	const paletteOrigin = useRef<HTMLElement | null>(null);
	const openPalette = useCallback((options: PaletteOptions = {}): void => {
		paletteOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setHelp(false);
		setPalette(options);
		setPaletteOpening((count) => count + 1);
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
	// A browser session is what there is to sign out of. In local mode the owner of the machine has none, and
	// neither the button nor its key is there.
	const account = info.via === "cookie";
	const [signOutState, setSignOutState] = useState<"closed" | "choosing" | "ending">("closed");
	const signingOut = signOutState === "ending";
	const signOutOpen = signOutState === "choosing";
	const signOutOrigin = useRef<HTMLElement | null>(null);
	const leave = useCallback((): void => {
		if (signOutState !== "closed") return;
		signOutOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setPalette(null);
		setHelp(false);
		setSignOutState("choosing");
	}, [signOutState]);
	const stay = (): void => {
		setSignOutState("closed");
		const origin = signOutOrigin.current;
		signOutOrigin.current = null;
		queueMicrotask(() => {
			if (origin?.isConnected) origin.focus();
		});
	};
	const confirmSignOut = (clear: boolean): void => {
		if (!signOutOpen) return;
		setSignOutState("ending");
		void signOut({ clear }).then((result) => {
			if (result === "signed-out") return signedOut();
			setSignOutState("closed");
			setStatus(
				result === "signed-in"
					? "The sign-out did not finish, and this browser is still signed in. Press Sign out again."
					: "Mainworthy did not answer, so the page cannot tell whether you are signed out. Your browser data was kept. Press Sign out again to retry, or clear this site's data in your browser settings before leaving a shared computer.",
			);
		});
	};
	const [inInput, setInInput] = useState(false);
	// Collapsed or open is this browser's choice, as the theme is: a reload and the next visit find it as it was.
	const [sidebarCollapsed, setSidebarCollapsed] = useState(sidebarKept);
	useEffect(() => keepSidebar(sidebarCollapsed), [sidebarCollapsed]);
	const sidebarAction = sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
	const { phone, pane, showList, menu, setMenu, listOnly } = usePhoneShell(
		route,
		palette !== null || help || signOutOpen,
	);
	const suiteParams = new URLSearchParams(location.search);
	const archived = suiteParams.get("state") === "archived";
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
	// A phone on which the detail of the selected row is covered: only the actions of the list run, by a key
	// or from the palette (decision 0018).
	useKeyboard({ listOnly, overlayOpen: palette !== null || help || signOutOpen });
	useEvents(project, setStatus);
	const folders = useQueryOp({ project, op: "find", input: { in: "folders" } });
	const tags = useQueryOp({ project, op: "find", input: { in: "tags" }, enabled: suiteOpen });
	const tagRows = useMemo(
		() => z.array(z.object({ tag: z.string(), n: z.number() })).parse(tags.data?.items ?? []),
		[tags.data],
	);
	const inbox = useQueryOp({ project, op: "inbox", input: { state: "open", limit: 1 } });
	const go = (screen: Screen) => navigate(routeUrl({ project, screen }));
	const goHome = useCallback(async (): Promise<void> => {
		const navigation = navigationToken();
		const owner = deviceSession();
		try {
			const home = await resolveHome(project);
			if (!sessionCurrent(owner) || navigationToken() !== navigation) return;
			navigate(home.url);
			if (home.missing) setStatus(missingHomeStatus);
		} catch (error) {
			if (!sessionCurrent(owner) || navigationToken() !== navigation) return;
			setStatus(error instanceof Error ? error.message : "Cannot read your home. Try again.");
		}
	}, [project]);
	const filterSuite = (changes: { folder?: string | null; tag?: string | null; state?: string | null }): void => {
		const params = new URLSearchParams(location.search);
		for (const [key, value] of Object.entries(changes)) {
			if (value === null) params.delete(key);
			else params.set(key, value);
		}
		navigate(`${routeUrl({ project, screen: "suite" })}${params.size ? `?${params}` : ""}`);
	};
	// The projects the session names, as the choices of the palette: the sidebar's button and g p list them
	// alone, and the palette finds one by a word of its name or key.
	const projectChoices = useMemo(
		(): PaletteItem[] =>
			info.projects.map((entry) => {
				const current = entry.key === project;
				return {
					id: `project:${entry.key}`,
					label: projectLabel(entry),
					detail: `${current ? "Current · " : ""}${entry.key} · ${entry.policy}`,
					current,
					handler: () => {
						if (!current) navigate(projectUrl({ project: entry.key, screen: route.screen }));
					},
				};
			}),
		[info.projects, project, route.screen],
	);
	// With one project there is nothing to pick: the sidebar names it, and neither the button nor its key is there.
	const switchable = info.projects.length > 1;
	const pickProject = useCallback(
		(): void => openPalette({ title: "Switch project", items: projectChoices }),
		[openPalette, projectChoices],
	);
	const opened = info.projects.find((entry) => entry.key === project);
	const projectName = opened ? projectLabel(opened) : project;
	const globalKeys = useMemo(
		() => [
			// A phone has no sidebar to collapse: the Menu button draws it over the pane.
			...(phone
				? []
				: [
						{
							key: "[",
							label: "Collapse / expand sidebar",
							handler: () => setSidebarCollapsed((value) => !value),
						},
					]),
			...[...navigation, settings].map((item) => ({
				key: item.key,
				label: `Go to ${item.label}`,
				list: true,
				handler: () => navigate(routeUrl({ project, screen: item.screen })),
			})),
			{
				key: "g h",
				label: "Go home",
				list: true,
				handler: () => void goHome(),
			},
			// It goes somewhere and records nothing, so a phone offers it while the list is shown, as it does a screen.
			...(switchable ? [{ key: "g p", label: "Switch project", list: true, handler: pickProject }] : []),
			{
				key: "mod+k",
				label: "Jump to or run",
				allowInOverlay: true,
				list: true,
				desktopOnly: true,
				handler: () => {
					setHelp(false);
					if (palette) closePalette();
					else openPalette();
				},
			},
			{
				key: "g d",
				label: "Docs for this screen",
				list: true,
				handler: () => openDocs(screenDocs[route.screen]),
			},
			{
				key: "?",
				label: "All keys",
				list: true,
				desktopOnly: true,
				handler: () => {
					setPalette(null);
					setHelp(true);
				},
			},
			{
				key: "escape",
				label: "Close palette / keys",
				allowInOverlay: true,
				list: true,
				hidden: true,
				applies: () => palette !== null || help,
				handler: () => {
					closePalette();
					setHelp(false);
				},
			},
			// Registered only where there is a session to end, so the palette and the keys sheet do not offer it
			// to the owner of a machine in local mode.
			...(account ? [{ key: "g x", label: "Sign out", list: true, handler: leave }] : []),
		],
		[
			project,
			route.screen,
			palette,
			help,
			openPalette,
			closePalette,
			account,
			leave,
			phone,
			switchable,
			pickProject,
			goHome,
		],
	);
	useBindings(globalKeys);
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
				(!binding.applies || binding.applies()) &&
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
				requestSignOut: leave,
			}}
		>
			<div
				id="app"
				// An attribute and not a class: the Suite puts `zoom` in the class list itself (`z`), and a class
				// written here would take it out again each time the sidebar changed.
				{...(phone
					? { "data-pane": pane, "data-menu": menu ? "open" : "closed" }
					: sidebarCollapsed
						? { "data-sidebar": "collapsed" }
						: {})}
				// The palette and the sheet of keys cover the whole app, and nothing under them takes the focus or
				// a key, on the desktop as on a phone: Tab would otherwise leave the sheet for the controls under
				// it, and Enter would press what it reaches.
				inert={palette !== null || help || signOutOpen}
			>
				{phone && (
					<PhoneBar
						title={
							[...navigation, settings].find(
								(item) => item.screen === (route.screen === "case" ? "suite" : route.screen),
							)?.label ?? ""
						}
						pane={pane}
						menu={menu}
						onMenu={() => setMenu(!menu)}
						onBack={showList}
						onActions={() => openPalette()}
					/>
				)}
				{menu && (
					<button
						type="button"
						className="menu-backdrop"
						tabIndex={-1}
						aria-label="Close menu"
						onClick={() => setMenu(false)}
					/>
				)}
				<aside id="side">
					<div className="brand">
						{/* On a phone the mark closes the drawer. On the desktop it is the mark, and the button after the
						    name collapses the sidebar: a button that looks like one, and says its key. */}
						{phone ? (
							<button type="button" className="logo" aria-label="Close menu" onClick={() => setMenu(false)}>
								<Mark />
							</button>
						) : (
							<span className="logo">
								<Mark />
							</span>
						)}
						<b>Mainworthy</b>
						{!phone && (
							<button
								type="button"
								className="side-toggle"
								aria-label={sidebarAction}
								title={`${sidebarAction} ([)`}
								onClick={() => setSidebarCollapsed((value) => !value)}
							>
								<SidebarIcon />
							</button>
						)}
					</div>
					{/* The project that is open, always here; with another to go to, the way there. */}
					{switchable ? (
						<button
							type="button"
							className="project"
							aria-label={`Project: ${projectName}. Switch project`}
							title="Switch project (g p)"
							onClick={pickProject}
						>
							<span className="project-word">Project</span>
							<b className="project-name">{projectName}</b>
							<span className="project-initial" aria-hidden="true">
								{initial(projectName)}
							</span>
							<span className="project-turn" aria-hidden="true">
								⇅
							</span>
							<KeyCap>g p</KeyCap>
						</button>
					) : (
						<div className="project">
							<span className="project-word">Project</span>
							<b className="project-name">{projectName}</b>
							<span className="project-initial" aria-hidden="true">
								{initial(projectName)}
							</span>
						</div>
					)}
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
									// Red only while a failure waits to be explained: a count that is always red is one nobody reads.
									<em
										className={waiting(inbox.data?.counts ?? {}).failures > 0 ? "hot" : ""}
										title={waitingPhrase(inbox.data?.counts ?? {})}
									>
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
								{["All cases", "Archived"].map((label, index) => (
									<button
										key={label}
										className={`fo ${route.folder === null && archived === Boolean(index) ? "on" : ""}`}
										type="button"
										onClick={() => filterSuite({ folder: null, state: index ? "archived" : null })}
									>
										<span className="tw" />
										<span className="fn">{label}</span>
										{!index && <span className="n">{folders.data?.count ?? 0}</span>}
									</button>
								))}
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
												onClick={() => filterSuite({ folder: path })}
												onDragOver={(event) => event.preventDefault()}
												onDrop={(event) => {
													event.preventDefault();
													window.dispatchEvent(
														new CustomEvent("mainworthy:drop", {
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
								{suiteParams.has("tag") && (
									<button type="button" className="fo" onClick={() => filterSuite({ tag: null })}>
										All tags
									</button>
								)}
								{tagRows.map(({ tag, n }) => (
									<button
										key={tag}
										type="button"
										className={`fo ${suiteParams.getAll("tag").includes(tag) ? "on" : ""}`}
										onClick={() => {
											filterSuite({ tag });
										}}
									>
										<span className="fn">#{tag}</span>
										<span className="n">{n}</span>
									</button>
								))}
							</div>
						</div>
					)}

					{/* Who is signed in, with their settings and the way out; then the docs, the keys and the theme. */}
					<div className="sfoot">
						<span className="me">
							<ProducerGlyph kind={info.kind} />
							{info.actor}
						</span>
						<a
							aria-label={settings.label}
							title={`${settings.label} (${settings.key})`}
							href={routeUrl({ project, screen: settings.screen })}
							className={route.screen === settings.screen ? "sfoot-link on" : "sfoot-link"}
							aria-current={route.screen === settings.screen ? "page" : undefined}
							onClick={(event) => {
								event.preventDefault();
								go(settings.screen);
							}}
						>
							{settings.icon}
						</a>
						{account && (
							<button
								type="button"
								aria-label="Sign out"
								title="Sign out (g x)"
								aria-disabled={signingOut}
								onClick={leave}
							>
								⇥ <span>{signingOut ? "Signing out…" : "Sign out"}</span>
							</button>
						)}
						<span className="sfoot-break" />
						{/* The page about the screen that is open, beside the app: what g d opens. */}
						<a
							className="sfoot-link"
							aria-label="Docs"
							title="Docs for this screen (g d)"
							href={docUrl(screenDocs[route.screen])}
							target="_blank"
							rel="noopener"
						>
							ⓘ <span>Docs</span>
						</a>
						<button type="button" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>
							? <span>Keys</span>
						</button>
						<button
							type="button"
							aria-label="Toggle theme"
							onClick={() => {
								const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
								localStorage.setItem("mainworthy:theme", next);
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
			{signOutOpen && <SignOutDialog person={info.actor} stay={stay} choose={confirmSignOut} />}
			{palette && (
				<Palette
					key={paletteOpening}
					project={project}
					projects={switchable ? projectChoices : []}
					options={palette}
					close={closePalette}
					typing={!phone}
					listOnly={listOnly}
				/>
			)}{" "}
			{help && (
				<div className="overlay" data-overlay="help">
					<button
						type="button"
						className="overlay-backdrop"
						tabIndex={-1}
						aria-label="Close keys"
						onClick={() => setHelp(false)}
					/>
					<section className="help" aria-label="Keyboard shortcuts">
						<button className="help-close" type="button" ref={focusOnce} onClick={() => setHelp(false)}>
							Close <KeyCap>Esc</KeyCap>
						</button>
						<h2>Keys</h2>
						<p className="help-docs">
							<DocLink page={screenDocs[route.screen]}>Docs for this screen</DocLink>
							<DocLink page="keyboard">Every key, on one page</DocLink>
						</p>
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
function SignOutDialog({
	person,
	stay,
	choose,
}: {
	person: string;
	stay: () => void;
	choose: (clear: boolean) => void;
}) {
	return (
		<div className="overlay" data-overlay="signout">
			<button
				type="button"
				className="overlay-backdrop"
				tabIndex={-1}
				aria-label="Close sign-out dialog"
				onClick={stay}
			/>
			<section
				className="signout-dialog"
				tabIndex={-1}
				onClick={(event) => {
					if (event.target instanceof Element && !event.target.closest("button")) event.currentTarget.focus();
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby="signout-title"
				aria-describedby="signout-warning"
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "Escape") {
						event.preventDefault();
						stay();
					} else if (event.key === "Tab") {
						event.preventDefault();
						const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
						const index =
							document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
						buttons[
							index < 0
								? event.shiftKey
									? buttons.length - 1
									: 0
								: (index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length
						]?.focus();
					} else if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
				}}
			>
				<h2 id="signout-title">Sign out</h2>
				<p id="signout-warning">
					Keep {person}'s drafts for next time, or clear this browser of their data. Clearing deletes their unsaved case
					drafts, queue answers and run notes in every open tab. Unsaved text cannot be recovered.
				</p>
				<div className="signout-choices">
					<button type="button" className="out" ref={focusOnce} onClick={() => choose(false)}>
						Sign out and keep drafts
					</button>
					<button type="button" className="out danger" onClick={() => choose(true)}>
						Sign out and clear browser data
					</button>
					<button type="button" className="out" onClick={stay}>
						Stay signed in <KeyCap>Esc</KeyCap>
					</button>
				</div>
			</section>
		</div>
	);
}

function Palette({
	project,
	projects,
	options,
	close,
	typing,
	listOnly,
}: {
	project: string;
	/** The other projects to go to, found once something is typed. Empty when there is one project. */
	projects: PaletteItem[];
	options: PaletteOptions;
	close: (chosen?: boolean) => void;
	/**
	 * Whether the field takes the focus as the palette opens. On a phone it does not: the keyboard that comes
	 * with the focus would cover the actions, which a finger chooses from the list.
	 */
	typing: boolean;
	/** A phone that shows the list: only the actions of the list are offered (`Binding.list`). */
	listOnly: boolean;
}) {
	const [text, setText] = useState("");
	// The choice starts on the first thing that is not already so: with the projects listed, the first other one.
	const [cursor, setCursor] = useState(() => Math.max(0, options.items?.findIndex((item) => !item.current) ?? 0));
	const registry = useKeyRegistry();
	const found = useQueryOp({
		project,
		op: "find",
		input: { in: "cases", text, limit: 30 },
		enabled: options.items ? false : text.length > 0 || Boolean(options.onPickCase),
	});
	const actions =
		options.items ??
		registry
			.filter(
				(item) =>
					!item.hidden &&
					(!item.applies || item.applies()) &&
					(!listOnly || item.list) &&
					(typing || !item.desktopOnly),
			)
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
	const words = text.toLowerCase().split(/\s+/).filter(Boolean);
	const says = (said: string) => words.every((word) => said.toLowerCase().includes(word));
	// The other projects, once something is typed: "project checkout", or a word of a name or a key.
	const others =
		words.length === 0
			? []
			: projects
					.filter((item) => !item.current && says(`project ${item.label} ${item.detail}`))
					.map((item) => ({ ...item, label: `Project: ${item.label}` }));
	// The pages of the documentation, once something is typed: "docs policy", or a word of a page's title.
	const docs =
		words.length === 0
			? []
			: DOC_PAGES.filter((page) => says(`docs ${page.section} ${page.title}`)).map((page) => ({
					id: `docs:${page.slug}`,
					label: `Docs: ${page.title}`,
					detail: "↗",
					handler: () => openDocs(page.slug),
				}));
	const items: PaletteItem[] = options.onPickCase
		? [...jump, ...cases]
		: options.items
			? // A list a screen or the shell gave is all there is to pick from, found by what its rows show.
				options.items.filter((item) => says(`${item.label} ${item.detail ?? ""}`))
			: [
					...jump,
					...actions.filter((item) => !text || item.label.toLowerCase().includes(text.toLowerCase())),
					...others,
					...docs,
					...cases,
				];
	const choose = (index: number) => {
		const item = items[index];
		if (item) {
			// The app under the palette is inert until the palette is gone from the page, so it is gone before
			// the action runs: Filter puts the caret in its field, New case in the editor.
			flushSync(() => close(true));
			item.handler();
		}
	};
	// On a phone the palette itself takes the focus, since its field does not: a key then goes to the palette
	// and not to what is under it.
	const sheet = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!typing) sheet.current?.focus();
	}, [typing]);
	return (
		<div className="overlay" data-overlay="palette">
			<button
				type="button"
				className="overlay-backdrop"
				tabIndex={-1}
				aria-label="Close palette"
				onClick={() => close()}
			/>
			<section
				className="pal"
				aria-label={options.title ?? "Command palette"}
				ref={sheet}
				{...(typing ? {} : { tabIndex: -1 })}
				// The arrows and Enter work from the field and from the sheet, which holds the focus where the field
				// does not (a phone). A row that Tab reached keeps its own Enter.
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget && !(event.target instanceof HTMLInputElement)) return;
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
			>
				<input
					className="palette-input"
					ref={typing ? focusOnce : undefined}
					aria-label={options.title ?? "Jump to or run"}
					placeholder={options.title ?? "Jump to a ref, search cases, or run an action…"}
					value={text}
					onChange={(event) => {
						setText(event.target.value);
						setCursor(0);
					}}
				/>
				<div className="palette-list" role="listbox" aria-label={options.title ?? "Commands and cases"}>
					{items.map((item, index) => (
						<button
							key={item.id}
							type="button"
							role="option"
							aria-selected={cursor === index}
							className={`pi ${cursor === index ? "on" : ""}`}
							onClick={() => choose(index)}
						>
							<span className="ic">{item.current ? "✓" : item.id.startsWith("C-") ? "▤" : "›"}</span>
							<span className="t">{item.label}</span>
							<span className="h">{item.detail}</span>
						</button>
					))}
					{items.length === 0 && (
						<div className="pi faint">
							{/* A list that was given holds no cases, so a ref finds nothing in it. */}
							{options.items ? "No matches." : "No matches. Try a case ref or a different title."}
						</div>
					)}
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
