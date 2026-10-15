import { useState } from "react";
import type { z } from "zod";
import { newStepId } from "../../core/ids.ts";
import type { FragmentPin } from "../../core/model.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { type Draft, knownStepIds } from "../lib/drafts.ts";
import { CaseView } from "../suite/model.ts";
import { useApp } from "../ui/context.tsx";
import type { DraftChange } from "./editor.tsx";

export function FragmentReference({ pin, remove }: { pin: z.infer<typeof FragmentPin>; remove: (() => void) | null }) {
	const { project } = useApp();
	const read = useQueryOp({ project, op: "get", input: { refs: [pin.fragment], version: pin.version } });
	const parsed = CaseView.safeParse(read.data?.[0]);
	const fragment =
		parsed.success && parsed.data.ref === pin.fragment && parsed.data.version === pin.version ? parsed.data : null;
	return (
		<section className="fragment-reference">
			<p>
				From {pin.fragment} v{pin.version}
				{fragment ? ` · ${fragment.title}` : ""}
			</p>
			{fragment ? (
				<ol>
					{fragment.steps.map((step) => (
						<li key={step.id}>
							{step.action}
							{step.expected && <div>&gt; {step.expected}</div>}
						</li>
					))}
				</ol>
			) : (
				<p role="status">{read.error?.message ?? "Reading fragment…"}</p>
			)}
			{remove && (
				<button type="button" onClick={remove}>
					Remove fragment
				</button>
			)}
		</section>
	);
}

export function FragmentInsert({ draft, change }: { draft: Draft; change: DraftChange }) {
	const { project } = useApp();
	const [ref, setRef] = useState("");
	const [version, setVersion] = useState("");
	const read = useQueryOp({
		project,
		op: "get",
		input: { refs: [ref], ...(version ? { version: Number(version) } : {}) },
		enabled: /^C-[1-9]\d*$/.test(ref),
	});
	const parsed = CaseView.safeParse(read.data?.[0]);
	const fragment =
		parsed.success &&
		parsed.data.ref === ref &&
		parsed.data.kind === "fragment" &&
		(!version || parsed.data.version === Number(version))
			? parsed.data
			: null;
	return (
		<details>
			<summary>Insert fragment</summary>
			<label>
				Fragment ref{" "}
				<input
					aria-label="Fragment ref"
					value={ref}
					placeholder="C-1"
					onChange={(event) => setRef(event.target.value.trim().toUpperCase())}
				/>
			</label>
			<label>
				Version{" "}
				<input
					aria-label="Fragment version"
					type="number"
					min="1"
					placeholder="Current version"
					value={version}
					onChange={(event) => setVersion(event.target.value)}
				/>
			</label>
			{fragment && (
				<p>
					{fragment.title} · pins v{fragment.version}
				</p>
			)}
			{read.error && <p role="status">{read.error.message}</p>}
			<button
				type="button"
				disabled={!fragment}
				onClick={() => {
					if (!fragment) return;
					const id = newStepId(
						knownStepIds({
							project,
							id: draft.id,
							ids: [...draft.body.steps, ...draft.original.steps].map((step) => step.id),
						}),
					);
					change({
						...draft,
						dirty: true,
						body: {
							...draft.body,
							steps: [
								...draft.body.steps,
								{ id, action: "", expected: null, use: { fragment: fragment.ref, version: fragment.version } },
							],
						},
					});
					setRef("");
					setVersion("");
				}}
			>
				Insert pinned fragment
			</button>
		</details>
	);
}

export function FragmentUsers({ view }: { view: CaseView }) {
	const { project, setStatus } = useApp();
	const versions = [...new Set(view.users.flatMap((user) => user.versions))]
		.filter((version) => version !== view.head)
		.sort((a, b) => a - b);
	const [from, setFrom] = useState(versions[0] ?? 0);
	const [selected, setSelected] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const currentBasis = JSON.stringify([view.ref, view.head, view.users]);
	const [basis, setBasis] = useState(currentBasis);
	if (basis !== currentBasis) {
		setBasis(currentBasis);
		setFrom(versions[0] ?? 0);
		setSelected([]);
	}
	const users = view.users.filter((user) => user.versions.includes(from));
	async function update() {
		setBusy(true);
		try {
			const reply = await call(
				"propose",
				{
					edits: [
						{
							op: "fragment",
							fragment: view.ref,
							from,
							to: view.head,
							cases: users
								.filter((user) => selected.includes(user.case))
								.map(({ case: ref, base }) => ({ case: ref, base })),
						},
					],
					reason: `Update ${view.ref} from v${from} to v${view.head}`,
				},
				{ project },
			);
			setStatus(
				reply.status === "adopted"
					? `Updated ${reply.cases.length} cases in ${reply.proposal}`
					: `Fragment update ${reply.status}: ${reply.question ?? reply.needs ?? "read the proposal"}`,
			);
			setSelected([]);
			await invalidateProject(project);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Fragment update failed");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section>
			<h3>Fragment users</h3>
			{view.users.length ? (
				<ul>
					{view.users.map((user) => (
						<li key={user.case}>
							{user.case} v{user.base} · fragment {user.versions.map((version) => `v${version}`).join(", ")}
						</li>
					))}
				</ul>
			) : (
				<p>No cases use this fragment.</p>
			)}
			{versions.length > 0 && (
				<>
					<label>
						Update users pinned to{" "}
						<select
							aria-label="Old fragment version"
							value={from}
							disabled={busy}
							onChange={(event) => {
								setFrom(Number(event.target.value));
								setSelected([]);
							}}
						>
							{versions.map((version) => (
								<option key={version} value={version}>
									v{version}
								</option>
							))}
						</select>
					</label>
					{users.map((user) => (
						<label key={user.case}>
							<input
								type="checkbox"
								aria-label={`Update ${user.case}`}
								checked={selected.includes(user.case)}
								disabled={busy}
								onChange={(event) =>
									setSelected(
										event.target.checked ? [...selected, user.case] : selected.filter((ref) => ref !== user.case),
									)
								}
							/>
							{user.case}
						</label>
					))}
					<button
						type="button"
						disabled={busy || !users.some((user) => selected.includes(user.case))}
						onClick={() => void update()}
					>
						Update selected to v{view.head}
					</button>
					<p>Unselected cases keep their pins. One proposal records the selected updates.</p>
				</>
			)}
		</section>
	);
}
