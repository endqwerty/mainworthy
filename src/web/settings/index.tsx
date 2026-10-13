import { useRef, useState } from "react";
import { z } from "zod";
import { Capability, Policy } from "../../core/kinds.ts";
import { PRESET_GUIDE, PRESET_SUMMARY } from "../../core/policy-guide.ts";
import { presetOf } from "../../core/presets.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { randomId } from "../lib/ids.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, KeyCap, ListRow, ProducerGlyph, SectionHeading } from "../ui/index.tsx";
import "./settings.css";

const sections = ["Policy", "Tokens", "Projects", "Connect"];
const Token = z.object({
	id: z.number(),
	actor: z.string(),
	kind: z.string(),
	label: z.string(),
	createdAt: z.number(),
	lastUsedAt: z.number().nullable(),
	revoked: z.boolean(),
});
const CreatedToken = z.object({ actor: z.string(), token: z.string(), can: z.array(Capability), note: z.string() });
const Preset = z.enum(["loose", "standard", "strict"]);
type Preset = z.infer<typeof Preset>;

/**
 * The presets side by side, wherever one is chosen. `marked` is the preset in force or the one about to be
 * chosen, and `as` says which.
 */
function PresetGuide({ marked, as }: { marked: Preset | null; as: string }) {
	return (
		<details className="settings-guide">
			<summary>Compare the policies</summary>
			<div className="settings-table-scroll">
				<table className="settings-table">
					<thead>
						<tr>
							<th scope="col">Who answers</th>
							{Preset.options.map((name) => (
								<th key={name} scope="col" aria-current={name === marked ? "true" : undefined}>
									{name === marked ? `${name} · ${as}` : name}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{PRESET_GUIDE.map((row) => (
							<tr key={row.question}>
								<th scope="row">{row.question}</th>
								{Preset.options.map((name) => (
									<td key={name} className={name === marked ? "marked" : undefined}>
										{row.answeredBy[name]}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<ul className="dim">
				<li>
					By rule: nobody is asked. The policy gives that answer and records the decision, and a person can still
					overrule it.
				</li>
				<li>
					A person is anyone with the answer permission, and an admin is a person with the admin permission. Where
					agents advise, an agent's answer is shown with the question and settles nothing.
				</li>
				<li>Where a cell names an answer, such as Duplicate or Reject, that one answer has its own rule.</li>
				<li>No policy decides what blocks a build. A failure nobody has explained blocks every run that shows it.</li>
			</ul>
		</details>
	);
}

export function SettingsScreen() {
	const { project } = useApp();
	return <SettingsWorkbench key={project} />;
}
function SettingsWorkbench() {
	const { project, session, instanceCan, overlayOpen, refreshSession, setStatus } = useApp();
	const [section, setSection] = useState("Policy");
	const [switching, setSwitching] = useState<string | null>(null);
	const [policyMessage, setPolicyMessage] = useState("");
	const admin = session.can.includes("admin");
	const instanceAdmin = instanceCan.includes("admin");
	const currentProject = session.projects.find((p) => p.key === project);
	const mayRead = session.can.includes("read");
	const policyRead = useQueryOp({
		project,
		op: "admin",
		input: { do: "policy.show", project },
		enabled: instanceAdmin && mayRead,
	});
	const parsedPolicy = Policy.safeParse(policyRead.data);
	const policy = parsedPolicy.success ? parsedPolicy.data : null;
	// The name is a preset's only while the clauses are that preset's. The session's name is checked by the server;
	// the clauses, which only an instance admin reads, are checked here.
	const preset = policy
		? (presetOf(policy) ?? "custom")
		: (session.projects.find((p) => p.key === project)?.policy ?? "Policy unavailable");
	const inForce = Preset.safeParse(preset).data ?? null;
	const actorRef = useRef<HTMLInputElement>(null);
	const projectRef = useRef<HTMLInputElement>(null);
	useBindings([
		{
			key: "j",
			label: "Next setting",
			when: () => !overlayOpen,
			handler: () => setSection(sections[Math.min(sections.length - 1, sections.indexOf(section) + 1)] ?? "Policy"),
		},
		{
			key: "k",
			label: "Previous setting",
			when: () => !overlayOpen,
			handler: () => setSection(sections[Math.max(0, sections.indexOf(section) - 1)] ?? "Policy"),
		},
		{
			key: "n",
			label: section === "Tokens" ? "New token" : "New project",
			when: () => !overlayOpen && instanceAdmin && (section === "Tokens" || section === "Projects"),
			handler: () => (section === "Tokens" ? actorRef.current?.focus() : projectRef.current?.focus()),
		},
	]);
	async function changePolicy(next: string): Promise<void> {
		if (!admin || switching || next === preset) return;
		setSwitching(next);
		setPolicyMessage(`Recording the ${next} policy proposal and decision…`);
		try {
			const proposed = await call(
				"propose",
				{
					edits: [{ op: "policy", preset: next }],
					reason: `Use the ${next} preset, selected in Settings.`,
					cmd: randomId(),
				},
				{ project },
			);
			if (!proposed.question) throw new Error("The policy proposal did not return a review question.");
			const question = z
				.object({ q: z.string(), evidenceHash: z.string() })
				.parse((await call("get", { refs: [proposed.question] }, { project }))[0]);
			const replies = await call(
				"decide",
				{
					q: question.q,
					onEvidence: question.evidenceHash,
					answer: { is: "accept" },
					reason: `Use the ${next} preset, selected in Settings.`,
					cmd: randomId(),
				},
				{ project },
			);
			if (replies[0]?.status !== "decided" && replies[0]?.status !== "already")
				throw new Error(`Policy is awaiting ${replies[0]?.needs ?? "review"}. Open ${question.q} in Queue.`);
			setPolicyMessage(
				`${next} is in force. Proposal ${proposed.proposal} and decision ${question.q} are both recorded.`,
			);
			setStatus(`${next} policy recorded through ${proposed.proposal} and ${question.q}.`);
			await invalidateProject(project);
			await refreshSession();
		} catch (error) {
			const message = error instanceof Error ? error.message : "The policy could not be changed.";
			setPolicyMessage(message);
			setStatus(message);
		} finally {
			setSwitching(null);
		}
	}
	return (
		<>
			<section className="pane settings-pane" id="list">
				<div className="phead">
					<b>Settings</b>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Settings sections">
					{sections.map((name) => (
						<ListRow key={name} selected={section === name} onClick={() => setSection(name)}>
							{name}
						</ListRow>
					))}
				</div>
			</section>
			<section className="pane settings-pane" id="detail">
				<div className="phead">
					<b>{section}</b>
					<span className="dim">{project}</span>
				</div>
				<div className="pane-scroll detail-body">
					{!mayRead && <p role="status">Your session may not read this project.</p>}
					{section === "Policy" && mayRead && currentProject && (
						<>
							<div className="settings-policy-head">
								<div>
									<h2>{preset}</h2>
									<p className="dim">The policy decides whose answers count.</p>
									<p className="settings-preset-summary">
										{inForce
											? PRESET_SUMMARY[inForce]
											: "This project has a custom policy. Its clause table says who answers, and an instance admin can read it."}
									</p>
								</div>
								<label>
									Preset{" "}
									<select
										className="form-input"
										aria-label="Policy preset"
										value={switching ?? preset}
										disabled={!admin || Boolean(switching)}
										onChange={(event) => {
											event.currentTarget.blur();
											void changePolicy(event.target.value);
										}}
									>
										{!inForce && (
											<option value={preset} disabled>
												{preset}
											</option>
										)}
										{Preset.options.map((name) => (
											<option key={name} value={name}>
												{name}
											</option>
										))}
									</select>
								</label>
							</div>
							<PresetGuide marked={inForce} as="in force" />
							{/* A switch between two presets says nothing true of a policy that is neither. */}
							{(inForce || switching) && (
								<label className="settings-agent-toggle">
									<input
										type="checkbox"
										role="switch"
										aria-checked={(switching ?? preset) !== "loose"}
										checked={(switching ?? preset) !== "loose"}
										disabled={!admin || Boolean(switching)}
										onChange={(event) => void changePolicy(event.target.checked ? "standard" : "loose")}
									/>
									<span>
										<b>Agent edits need a person</b>
										<small>
											Switches between loose and standard. Both the policy proposal and its accepting decision are
											recorded.
										</small>
									</span>
								</label>
							)}
							<p className="settings-message" role="status">
								{policyMessage}
							</p>
							{policyRead.error && <p role="status">{policyRead.error.message}</p>}
							{!instanceAdmin && (
								<p className="dim">
									An instance admin can read the clause table; a project admin can change the policy.
								</p>
							)}
							{policy && (
								<>
									<SectionHeading>Clause table · first match wins</SectionHeading>
									<div className="settings-table-scroll">
										<table className="settings-table">
											<thead>
												<tr>
													<th>Clause</th>
													<th>Kind</th>
													<th>When</th>
													<th>Who answers</th>
													<th>Agent answer</th>
													<th>Blocks</th>
												</tr>
											</thead>
											<tbody>
												{policy.clauses.map((clause) => (
													<tr key={clause.id}>
														<td>{clause.id}</td>
														<td>{clause.kind}</td>
														<td>{clause.when.join(", ")}</td>
														<td>
															{clause.ask.who}
															{clause.ask.notProducer && ", not the producer"}
															{clause.ask.reason === "required" && ", with a reason"}
															{clause.ask.who === "rule" && `: ${JSON.stringify(clause.answer)}`}
														</td>
														<td>{clause.ask.agents}</td>
														<td>{clause.blocks}</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
									<p className="dim">
										Basis {policy.settings.basis} · flaky answers hold for {policy.settings.holds.flakyDays} days ·
										infrastructure{" "}
										{policy.settings.holds.infraThisTargetOnly
											? "excused for this target only"
											: "held until the evidence changes"}
										.
									</p>
								</>
							)}
						</>
					)}
					{section === "Tokens" &&
						(instanceAdmin ? (
							<TokenSettings actorRef={actorRef} />
						) : (
							<EmptyState>An admin creates and revokes tokens.</EmptyState>
						))}
					{section === "Projects" && <ProjectSettings inputRef={projectRef} />}
					{section === "Connect" && (
						<>
							<h2>Connect a pipeline</h2>
							<p>Report the runner's JUnit XML, then read the gate.</p>
							<pre className="settings-command">{`CASEBOOK_URL=${location.origin}\nCASEBOOK_PROJECT=${project}\ncasebook report results/*.xml\ncasebook gate`}</pre>
							<p className="dim">Set CASEBOOK_TOKEN to a pipeline token in the runner's secret store.</p>
							<SectionHeading>Connect an agent</SectionHeading>
							<p>Create an agent token with read and produce permissions. Under standard, edits wait for a person.</p>
							<pre className="settings-command">{`${location.origin}/mcp`}</pre>
							<p className="dim">Send the token as a Bearer authorization header to the MCP endpoint.</p>
						</>
					)}
				</div>
			</section>
		</>
	);
}
function TokenSettings({ actorRef }: { actorRef: React.RefObject<HTMLInputElement | null> }) {
	const { project, setStatus } = useApp();
	const read = useQueryOp({ project, op: "admin", input: { do: "token.list" } });
	const parsed = Token.array().safeParse(read.data);
	const [actor, setActor] = useState("");
	const [kind, setKind] = useState<"human" | "agent" | "ci">("agent");
	const [capabilities, setCapabilities] = useState<z.infer<typeof Capability>[]>(["read", "produce"]);
	const [created, setCreated] = useState<z.infer<typeof CreatedToken> | null>(null);
	const secretRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [revoking, setRevoking] = useState<Set<number>>(new Set());
	return (
		<>
			<h2>Tokens</h2>
			<p className="dim">A token identifies its producer and is limited to this project.</p>
			<form
				className="settings-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (!actor.trim() || busy) return;
					setBusy(true);
					setCreated(null);
					void call(
						"admin",
						{
							do: "token.create",
							actor: actor.trim(),
							kind,
							project,
							can: capabilities,
							label: `${kind} for ${project}`,
						},
						{ project },
					)
						.then((reply) => {
							setCreated(CreatedToken.parse(reply));
							setActor("");
							return read.refetch();
						})
						.catch((error: unknown) =>
							setStatus(error instanceof Error ? error.message : "The token could not be created."),
						)
						.finally(() => setBusy(false));
				}}
			>
				<label htmlFor="token-actor">Token actor</label>
				<input
					className="form-input"
					id="token-actor"
					ref={actorRef}
					value={actor}
					onChange={(event) => setActor(event.target.value)}
					placeholder="reviewer"
					required
				/>
				<label htmlFor="token-kind">Producer</label>
				<select
					className="form-input"
					id="token-kind"
					value={kind}
					onChange={(event) => {
						event.currentTarget.blur();
						setKind(z.enum(["human", "agent", "ci"]).parse(event.target.value));
					}}
				>
					<option value="agent">Agent</option>
					<option value="ci">Pipeline</option>
					<option value="human">Person</option>
				</select>
				<fieldset className="settings-capabilities">
					<legend>Permissions</legend>
					{Capability.options.map((can) => (
						<label key={can}>
							<input
								type="checkbox"
								checked={capabilities.includes(can)}
								onChange={(event) =>
									setCapabilities((value) =>
										event.target.checked ? [...value, can] : value.filter((entry) => entry !== can),
									)
								}
							/>
							{can}
						</label>
					))}
				</fieldset>
				<button className="out" type="submit" disabled={busy || !actor.trim() || !capabilities.length}>
					Create token
				</button>
			</form>
			{created && (
				<div className="settings-secret">
					<b>{created.note}</b>
					<p>
						{created.actor} · {created.can.join(", ")}
					</p>
					<input
						className="form-input"
						type="password"
						aria-label="New token"
						readOnly
						value={created.token}
						ref={secretRef}
					/>
					<div>
						<button
							className="out"
							type="button"
							onClick={() => {
								if (navigator.clipboard) {
									void navigator.clipboard
										.writeText(created.token)
										.then(() => setStatus("Token copied."))
										.catch(() => setStatus("Copy failed. Try again."));
									return;
								}
								const field = secretRef.current;
								if (!field) return;
								const focused = document.activeElement;
								try {
									// Plain HTTP has no async clipboard. Unmask only during this synchronous copy, before paint.
									field.type = "text";
									field.select();
									setStatus(document.execCommand("copy") ? "Token copied." : "Copy failed. Try again.");
								} catch {
									setStatus("Copy failed. Try again.");
								} finally {
									field.type = "password";
									if (focused instanceof HTMLElement) focused.focus();
								}
							}}
						>
							Copy token
						</button>
						<button type="button" className="dim" onClick={() => setCreated(null)}>
							Dismiss secret
						</button>
					</div>
				</div>
			)}
			<SectionHeading>Issued tokens</SectionHeading>
			{read.error && <p role="status">{read.error.message}</p>}
			{parsed.success &&
				parsed.data.map((token) => (
					<div className="settings-token" key={token.id}>
						<ProducerGlyph kind={token.kind} />
						<span>
							<b>{token.actor}</b>
							<small>
								{token.label} · created {age(token.createdAt)}
								{token.lastUsedAt && ` · last used ${age(token.lastUsedAt)}`}
							</small>
						</span>
						<span className="dim">{token.revoked ? "Revoked" : "Active"}</span>
						{!token.revoked && (
							<button
								className="out"
								type="button"
								disabled={revoking.has(token.id)}
								aria-label={`Revoke ${token.actor}`}
								onClick={() => {
									setRevoking((value) => new Set(value).add(token.id));
									void call("admin", { do: "token.revoke", id: token.id }, { project })
										.then(() => read.refetch())
										.catch((error: unknown) =>
											setStatus(error instanceof Error ? error.message : "The token could not be revoked."),
										)
										.finally(() =>
											setRevoking((value) => {
												const next = new Set(value);
												next.delete(token.id);
												return next;
											}),
										);
								}}
							>
								Revoke
							</button>
						)}
					</div>
				))}
			{parsed.success && !parsed.data.length && <p className="dim">No tokens yet. Press n to create one.</p>}
		</>
	);
}
function ProjectSettings({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
	const { session, instanceCan, project, refreshSession, setStatus } = useApp();
	const [key, setKey] = useState("");
	const [name, setName] = useState("");
	const [preset, setPreset] = useState<Preset>("loose");
	const [busy, setBusy] = useState(false);
	return (
		<>
			<h2>Projects</h2>
			{session.projects.map((p) => (
				<button
					className="settings-project"
					key={p.key}
					type="button"
					aria-pressed={project === p.key}
					onClick={() => navigate(routeUrl({ project: p.key, screen: "settings" }))}
				>
					<b>{p.name}</b>
					<span className="mono dim">
						{p.key} · {p.policy}
					</span>
					<span className="dim">{p.key === project ? "Current" : "Switch"}</span>
				</button>
			))}
			{instanceCan.includes("admin") && (
				<>
					<SectionHeading>Create a project</SectionHeading>
					<form
						className="settings-form wide"
						onSubmit={(event) => {
							event.preventDefault();
							if (busy) return;
							setBusy(true);
							void call(
								"admin",
								{
									do: "project.create",
									key,
									...(name.trim() ? { name: name.trim() } : {}),
									preset,
									cmd: randomId(),
								},
								{ project },
							)
								.then(async () => {
									await refreshSession();
									navigate(routeUrl({ project: key, screen: "settings" }));
									setStatus(`Project ${key} created.`);
								})
								.catch((error: unknown) =>
									setStatus(error instanceof Error ? error.message : "The project could not be created."),
								)
								.finally(() => setBusy(false));
						}}
					>
						<label htmlFor="project-key">Project key</label>
						<input
							className="form-input"
							id="project-key"
							ref={inputRef}
							value={key}
							onChange={(event) => setKey(event.target.value)}
							pattern={"[a-z0-9][a-z0-9\\-]{0,39}"}
							required
							placeholder="checkout"
						/>
						<label htmlFor="project-name">Project name, optional</label>
						<input
							className="form-input"
							id="project-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={120}
						/>
						<label htmlFor="project-preset">Initial policy</label>
						<select
							className="form-input"
							id="project-preset"
							aria-describedby="project-preset-help"
							value={preset}
							onChange={(event) => {
								event.currentTarget.blur();
								setPreset(Preset.parse(event.target.value));
							}}
						>
							{Preset.options.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
						<p className="settings-preset-summary" id="project-preset-help">
							{PRESET_SUMMARY[preset]}
						</p>
						<PresetGuide marked={preset} as="selected" />
						<button className="out" type="submit" disabled={busy || !key}>
							Create project
						</button>
						<p className="dim">
							<KeyCap>n</KeyCap> starts a new project.
						</p>
					</form>
				</>
			)}
		</>
	);
}
