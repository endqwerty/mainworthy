import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { ApiError, call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { randomId } from "../lib/ids.ts";
import { navigate, navigationToken, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { KeyCap, Select } from "../ui/index.tsx";

export function RunPlanner({ close }: { close: () => void }) {
	const { project, setStatus } = useApp();
	const [name, setName] = useState("");
	const [mode, setMode] = useState<"all" | "folder" | "tag" | "text">("all");
	const [filter, setFilter] = useState("");
	const [query, setQuery] = useState("");
	const [target, setTarget] = useState<"self" | "commit">("self");
	const [commit, setCommit] = useState("");
	const [submission, setSubmission] = useState<{
		state: "sending" | "uncertain";
		input: Api["plan"]["input"];
	} | null>(null);
	const busy = submission?.state === "sending";
	const nameRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		nameRef.current?.focus();
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
				if (!name.trim() || busy || (target === "commit" && commit.trim().length < 7)) return;
				const input = submission?.input ?? {
					name: name.trim(),
					select: selection(filter),
					...(target === "commit" ? { accepts: { commit: commit.trim() } } : {}),
					cmd: randomId(),
				};
				event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
				setSubmission({ state: "sending", input });
				const navigation = navigationToken();
				void call("plan", input, { project })
					.then((reply) => {
						setStatus(`${reply.run} planned with ${reply.slots} slots; ${reply.already} already filled.`);
						void invalidateProject(project);
						navigate(routeUrl({ project, screen: "runs", ref: reply.run }), { ifCurrent: navigation });
					})
					.catch((error: unknown) => {
						const refused = error instanceof ApiError;
						setSubmission(refused ? null : { state: "uncertain", input });
						setStatus(
							refused
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
			<label htmlFor="run-name">Run name</label>
			<input
				className="form-input"
				id="run-name"
				ref={nameRef}
				value={name}
				readOnly={submission !== null}
				onChange={(event) => setName(event.target.value)}
				placeholder="Regression for 1.4 rc3"
				required
				maxLength={200}
			/>
			<label htmlFor="run-selection">Cases</label>
			<Select
				className="form-input"
				id="run-selection"
				value={mode}
				disabled={submission !== null}
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
					disabled={submission !== null}
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
						readOnly={submission !== null}
						onChange={(event) => setFilter(event.target.value)}
						placeholder={mode === "tag" ? "regression" : "checkout"}
					/>
				)
			)}
			<div className="dim" role="status">
				{found.error ? found.error.message : `${found.data?.count ?? 0} matching cases`}
			</div>
			<label className="run-radio">
				<input
					type="radio"
					name="run-target"
					checked={target === "self"}
					disabled={submission !== null}
					onChange={() => setTarget("self")}
				/>{" "}
				Count only results recorded in this run
			</label>
			<label className="run-radio">
				<input
					type="radio"
					name="run-target"
					checked={target === "commit"}
					disabled={submission !== null}
					onChange={() => setTarget("commit")}
				/>{" "}
				Accept results for a commit
			</label>
			{target === "commit" && (
				<input
					className="form-input"
					aria-label="Commit"
					value={commit}
					readOnly={submission !== null}
					onChange={(event) => setCommit(event.target.value)}
					minLength={7}
					required
					placeholder="Commit SHA"
				/>
			)}
			<button type="submit" className="out" aria-disabled={busy || !name.trim()}>
				<KeyCap>Enter</KeyCap> {submission?.state === "uncertain" ? "Retry plan" : "Plan run"}
			</button>
			<button type="button" className="dim" onClick={close}>
				Cancel <KeyCap>Esc</KeyCap>
			</button>
		</form>
	);
}
