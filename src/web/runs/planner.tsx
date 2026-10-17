import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { randomId } from "../lib/ids.ts";
import { navigate, routeUrl } from "../lib/router.ts";
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
	const [busy, setBusy] = useState(false);
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
	const found = useQueryOp({
		project,
		op: "find",
		input: {
			in: "cases",
			...(mode === "folder" && query
				? { folder: query, deep: true }
				: mode === "tag" && query
					? { tags: [query.replace(/^#/, "")] }
					: mode === "text" && query
						? { text: query }
						: {}),
			limit: 1,
		},
	});
	const select: Api["plan"]["input"]["select"] =
		mode === "folder" && filter
			? { folders: [filter] }
			: mode === "tag" && filter
				? { tags: [filter.replace(/^#/, "")] }
				: mode === "text" && filter
					? { text: filter }
					: {};
	return (
		<form
			className="run-planner"
			onSubmit={(event) => {
				event.preventDefault();
				if (!name.trim() || busy || (target === "commit" && commit.trim().length < 7)) return;
				setBusy(true);
				void call(
					"plan",
					{
						name: name.trim(),
						select,
						...(target === "commit" ? { accepts: { commit: commit.trim() } } : {}),
						cmd: randomId(),
					},
					{ project },
				)
					.then((reply) => {
						setStatus(`${reply.run} planned with ${reply.slots} slots; ${reply.already} already filled.`);
						void invalidateProject(project);
						navigate(routeUrl({ project, screen: "runs", ref: reply.run }));
					})
					.catch((error: unknown) => {
						setStatus(error instanceof Error ? error.message : "The run could not be planned.");
						setBusy(false);
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
						onChange={(event) => setFilter(event.target.value)}
						placeholder={mode === "tag" ? "regression" : "checkout"}
					/>
				)
			)}
			<div className="dim" role="status">
				{found.data?.count === null ? "Too many matching cases to count" : `${found.data?.count ?? 0} matching cases`}
			</div>
			<label className="run-radio">
				<input type="radio" name="run-target" checked={target === "self"} onChange={() => setTarget("self")} /> Count
				only results recorded in this run
			</label>
			<label className="run-radio">
				<input type="radio" name="run-target" checked={target === "commit"} onChange={() => setTarget("commit")} />{" "}
				Accept results for a commit
			</label>
			{target === "commit" && (
				<input
					className="form-input"
					aria-label="Commit"
					value={commit}
					onChange={(event) => setCommit(event.target.value)}
					minLength={7}
					required
					placeholder="Commit SHA"
				/>
			)}
			<button type="submit" className="out" disabled={busy || !name.trim()}>
				<KeyCap>Enter</KeyCap> Plan run
			</button>
			<button type="button" className="dim" onClick={close}>
				Cancel <KeyCap>Esc</KeyCap>
			</button>
		</form>
	);
}
