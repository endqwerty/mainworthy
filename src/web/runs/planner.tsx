import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { PlanInput } from "../../core/selection.ts";
import { ApiError, call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { deviceKey, deviceSession, sessionCurrent } from "../lib/device.ts";
import { focusInto } from "../lib/focus.ts";
import { randomId } from "../lib/ids.ts";
import { navigate, navigationToken, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { KeyCap, Select } from "../ui/index.tsx";

const PendingPlan = PlanInput.extend({
	cmd: PlanInput.shape.cmd.unwrap(),
	projectIdentity: PlanInput.shape.projectIdentity.unwrap(),
});
type SavedPlan = { key: string; input: z.infer<typeof PendingPlan> };
type Submission = SavedPlan & { state: "sending" | "uncertain" | "released" };
const unreadablePlan = "This browser could not confirm the saved plan. Reopen the planner before retrying.";

/** The form's choices for a saved plan. */
function choicesOf(plan: Submission["input"] | null) {
	const { folders, tags, text } = plan?.select ?? {};
	const folder = folders?.[0];
	const accepts = plan?.accepts;
	return {
		mode: folders?.length
			? ("folder" as const)
			: tags?.length
				? ("tag" as const)
				: text
					? ("text" as const)
					: ("all" as const),
		filter: (typeof folder === "string" ? folder : undefined) ?? tags?.[0] ?? text ?? "",
		commit: accepts && "commit" in accepts ? accepts.commit : "",
	};
}

function readPlan(key: string, held?: SavedPlan | null): SavedPlan | null {
	for (const entry of [held?.key ?? key, ...Object.keys(localStorage)]) {
		if (entry !== key && !entry.startsWith(`${key}:`)) continue;
		const stored = localStorage.getItem(entry);
		if (stored === null) continue;
		try {
			const parsed = PendingPlan.safeParse(JSON.parse(stored));
			if (parsed.success) return { key: entry, input: parsed.data };
		} catch {}
		try {
			localStorage.removeItem(entry);
		} catch {}
	}
	return null;
}

function forgetPlan({ key, input }: SavedPlan) {
	const stored = localStorage.getItem(key);
	if (stored !== null && PendingPlan.parse(JSON.parse(stored)).cmd === input.cmd) localStorage.removeItem(key);
}

export function RunPlanner({ close }: { close: () => void }) {
	const { project, session, setStatus } = useApp();
	const projectIdentity = session.projects.find((entry) => entry.key === project)?.identity;
	const owner = useRef(deviceSession()).current;
	const key = deviceKey("run-plan", project, owner.actorId);
	const [initial] = useState(() => {
		try {
			return readPlan(key);
		} catch {
			return null;
		}
	});
	const chosen = choicesOf(initial?.input ?? null);
	const [name, setName] = useState(initial?.input.name ?? "");
	const [mode, setMode] = useState<"all" | "folder" | "tag" | "text">(chosen.mode);
	const [filter, setFilter] = useState(chosen.filter);
	const [query, setQuery] = useState(filter);
	const [target, setTarget] = useState<"self" | "commit">(chosen.commit ? "commit" : "self");
	const [commit, setCommit] = useState(chosen.commit);
	const [submission, setSubmission] = useState<Submission | null>(initial ? { state: "uncertain", ...initial } : null);
	const submitting = useRef(submission);
	const hold = useCallback((next: Submission | null) => {
		submitting.current = next;
		setSubmission(next);
	}, []);
	const show = useCallback((input: SavedPlan["input"] | null) => {
		const { mode, filter, commit } = choicesOf(input);
		setName(input?.name ?? "");
		setMode(mode);
		setFilter(filter);
		setQuery(filter);
		setTarget(commit ? "commit" : "self");
		setCommit(commit);
	}, []);
	const clearRemoved = useCallback(() => {
		const held = submitting.current;
		if (!held || !sessionCurrent(owner)) return false;
		if (held.state === "released") return true;
		try {
			if (localStorage.getItem(held.key) !== null) return false;
		} catch {
			return false;
		}
		hold({ ...held, state: "released" });
		show(null);
		setStatus(
			"This plan is no longer saved on this device. It may have been discarded or completed in another tab. Check Runs before planning again.",
		);
		return true;
	}, [owner, hold, show, setStatus]);
	useEffect(() => {
		const changed = (event: StorageEvent) => {
			if (event.storageArea === localStorage && (event.key === submitting.current?.key || event.key === null))
				clearRemoved();
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, [clearRemoved]);
	const busy = submission?.state === "sending";
	const locked = submission !== null && submission.state !== "released";
	const nameRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		focusInto(nameRef.current);
	}, []);
	useEffect(() => {
		const timer = setTimeout(() => setQuery(filter), 80);
		return () => clearTimeout(timer);
	}, [filter]);
	const folders = useQueryOp({ project, op: "find", input: { in: "folders" } });
	const parsedFolders = z.array(z.object({ path: z.string() })).safeParse(folders.data?.items);
	const selection = (value: string): Api["plan"]["input"]["select"] =>
		mode === "folder" && value
			? { folders: [value] }
			: mode === "tag" && value
				? { tags: [value.replace(/^#/, "")] }
				: mode === "text" && value
					? { text: value }
					: {};
	const found = useQueryOp({
		project,
		op: "find",
		input: {
			in: "cases",
			select: selection(query),
			limit: 1,
		},
	});
	return (
		<form
			className="run-planner"
			onSubmit={(event) => {
				event.preventDefault();
				if (
					!name.trim() ||
					submitting.current?.state === "sending" ||
					(target === "commit" && commit.trim().length < 7)
				)
					return;
				if (!sessionCurrent(owner)) return;
				let plan: SavedPlan;
				try {
					const held = submitting.current;
					const saved = readPlan(key, held);
					if (held && !saved) {
						if (!clearRemoved()) setStatus(unreadablePlan);
						return;
					}
					if (saved && saved.input.cmd !== held?.input.cmd) {
						setStatus("Another tab's plan is waiting; Retry plan sends it.");
						show(saved.input);
						hold({ ...saved, state: "uncertain" });
						return;
					}
					if (submitting.current?.state === "released") return;
					if (!projectIdentity) {
						setStatus("The current project's identity is unavailable. Reload before planning a run.");
						return;
					}
					if (saved && saved.input.projectIdentity !== projectIdentity) {
						setStatus(
							"This saved plan belongs to an earlier project and cannot be retried here. Discard it before planning a new run.",
						);
						return;
					}
					const input = saved?.input ?? {
						projectIdentity,
						name: name.trim(),
						select: selection(filter),
						...(target === "commit" ? { accepts: { commit: commit.trim() } } : {}),
						cmd: randomId(),
					};
					plan = saved ?? { key: `${key}:${input.cmd}`, input };
					if (!saved) localStorage.setItem(plan.key, JSON.stringify(input));
				} catch {
					setStatus(
						submitting.current
							? unreadablePlan
							: "This browser could not keep the plan request. Enable device storage before planning a run.",
					);
					return;
				}
				const { input } = plan;
				const forget = () => {
					if (!sessionCurrent(owner)) return;
					try {
						forgetPlan(plan);
					} catch {}
				};
				event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
				hold({ ...plan, state: "sending" });
				const navigation = navigationToken();
				void call("plan", input, { project, owner })
					.then((reply) => {
						forget();
						setStatus(`${reply.run} planned with ${reply.slots} slots; ${reply.already} already filled.`);
						void invalidateProject(project);
						navigate(routeUrl({ project, screen: "runs", ref: reply.run }), { ifCurrent: navigation });
					})
					.catch((error: unknown) => {
						if (!sessionCurrent(owner) || clearRemoved() || submitting.current?.input.cmd !== input.cmd) return;
						const definite = error instanceof ApiError && error.status !== null && error.code !== "busy";
						const replayChanged =
							definite &&
							error.code === "conflict" &&
							error.message === "this command id was already used for another request; send new content under a new id";
						const refused =
							definite &&
							!replayChanged &&
							(error.code === "invalid" ||
								error.code === "conflict" ||
								(error.code === "not_found" &&
									error.message !== `no project named ${project}, or no grant on it` &&
									error.message !== "no operation named plan" &&
									error.message !== "no such route"));
						if (refused) forget();
						if (!sessionCurrent(owner)) return;
						hold(refused ? null : { ...plan, state: "uncertain" });
						setStatus(
							replayChanged
								? "This saved plan could not be replayed. A run may already exist. Check Runs before discarding it."
								: refused
									? error.message
									: "The run's outcome is unknown. Retry plan sends the same request; your submitted choices are kept.",
						);
					});
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					close();
				}
			}}
		>
			{submission?.state === "uncertain" && (
				<p className="dim" role="status">
					A plan's outcome is unknown. Retry plan sends the same request. Closing the planner keeps it on this device.
					This plan may already have been recorded. Discarding it does not undo a run.
				</p>
			)}
			<label htmlFor="run-name">Run name</label>
			<input
				className="form-input"
				id="run-name"
				ref={nameRef}
				value={name}
				readOnly={locked}
				onChange={(event) => {
					if (submitting.current?.state === "released") hold(null);
					setName(event.target.value);
				}}
				placeholder="Regression for 1.4 rc3"
				required
				maxLength={200}
			/>
			<label htmlFor="run-selection">Cases</label>
			<Select
				className="form-input"
				id="run-selection"
				value={mode}
				disabled={locked}
				onChange={(event) => {
					const value = z.enum(["all", "folder", "tag", "text"]).parse(event.target.value);
					setMode(value);
					setFilter("");
				}}
			>
				<option value="all">All active cases</option>
				<option value="folder">By folder</option>
				<option value="tag">By tag</option>
				<option value="text">By search</option>
			</Select>
			{mode === "folder" ? (
				<Select
					className="form-input"
					aria-label="Folder"
					value={filter}
					disabled={locked}
					onChange={(event) => {
						setFilter(event.target.value);
					}}
				>
					<option value="">All folders</option>
					{parsedFolders.success &&
						parsedFolders.data.map((folder) => (
							<option key={folder.path} value={folder.path}>
								{folder.path || "Root"}
							</option>
						))}
				</Select>
			) : (
				mode !== "all" && (
					<input
						className="form-input"
						aria-label={mode === "tag" ? "Tag" : "Search cases"}
						value={filter}
						readOnly={locked}
						onChange={(event) => setFilter(event.target.value)}
						placeholder={mode === "tag" ? "regression" : "checkout"}
					/>
				)
			)}
			<div className="dim" role="status">
				{found.error ? found.error.message : `${found.data?.count ?? 0} matching cases`}
			</div>
			{(["self", "commit"] as const).map((value) => (
				<label className="run-radio" key={value}>
					<input
						type="radio"
						name="run-target"
						checked={target === value}
						disabled={locked}
						onChange={() => setTarget(value)}
					/>{" "}
					{value === "self" ? "Count only results recorded in this run" : "Accept results for a commit"}
				</label>
			))}
			{target === "commit" && (
				<input
					className="form-input"
					aria-label="Commit"
					value={commit}
					readOnly={locked}
					onChange={(event) => setCommit(event.target.value)}
					minLength={7}
					required
					placeholder="Commit SHA"
				/>
			)}
			<button type="submit" className="out" aria-disabled={busy || !name.trim()}>
				<KeyCap>Enter</KeyCap> {submission?.state === "uncertain" ? "Retry plan" : "Plan run"}
			</button>
			{submission?.state === "uncertain" && (
				<button
					type="button"
					className="dim"
					onClick={() => {
						if (!sessionCurrent(owner)) return;
						try {
							forgetPlan(submission);
						} catch {
							setStatus("This browser could not discard the saved plan. Enable device storage and try again.");
							return;
						}
						hold(null);
						setStatus("The saved plan was discarded. Any run already recorded is unchanged.");
						focusInto(nameRef.current);
					}}
				>
					Discard this plan
				</button>
			)}
			<button type="button" className="dim" onClick={close}>
				Cancel <KeyCap>Esc</KeyCap>
			</button>
		</form>
	);
}
