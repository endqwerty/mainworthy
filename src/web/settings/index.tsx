import { useRef, useState } from "react";
import { z } from "zod";
import {
	Capability,
	CI_CAPABILITIES,
	defaultCapabilities,
	UNLINKED_HELP,
	UNLINKED_LABELS,
	Unlinked,
} from "../../core/kinds.ts";
import { PRESET_GUIDE, PRESET_SUMMARY } from "../../core/policy-guide.ts";
import { presetOf } from "../../core/presets.ts";
import { ApiError, call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { randomId } from "../lib/ids.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, projectUrl, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { DocLink, EmptyState, KeyCap, ListRow, SectionHeading, Select } from "../ui/index.tsx";
import { QuarantineList } from "../ui/quarantine.tsx";
import { CustomFields } from "./fields.tsx";
import { YourHome } from "./home.tsx";
import { People } from "./people.tsx";
import { type ClauseChange, PolicyEditor, PolicySnapshot, policyConflictMessage } from "./policy.tsx";
import { YourSessions } from "./sessions.tsx";
import { YourSignIn } from "./signin.tsx";
import { IssuedTokens } from "./tokens.tsx";
import "./settings.css";

type PolicyChange =
	| { preset: string }
	| { unlinked: Unlinked }
	| { settings: PolicySnapshot["settings"]; base: number }
	| ClauseChange;

/**
 * The sections a caller is shown, in the order of the list. "People" is for an admin of the instance who is a
 * person, which is who the server lets invite. "Your sign-in" is for a person: nobody else has a password or a
 * passkey. "Your sessions" is for whoever can have a browser session, which a pipeline cannot.
 */
const sectionsFor = (caller: { kind: string; instanceAdmin: boolean }): string[] => [
	"Policy",
	"Tokens",
	...(caller.instanceAdmin && caller.kind === "human" ? ["People"] : []),
	"Projects",
	"Connect",
	"Your home",
	...(caller.kind === "human" ? ["Your sign-in"] : []),
	...(caller.kind === "ci" ? [] : ["Your sessions"]),
];
const CreatedToken = z.object({ actor: z.string(), token: z.string(), can: z.array(Capability), note: z.string() });
/**
 * How long a new token may work. Each value is a duration as `token.create` reads it (`src/core/duration.ts`);
 * the empty one is a token with no end.
 */
const LIFETIMES = [
	{ value: "", label: "Never" },
	{ value: "30d", label: "30 days" },
	{ value: "90d", label: "90 days" },
	{ value: "365d", label: "1 year" },
] as const;

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
	// A person back from the identity provider returns to the section they left (`OidcReturn`).
	const [section, setSection] = useState(() => {
		const back = (history.state as { settingsSection?: unknown } | null)?.settingsSection;
		return typeof back === "string" ? back : "Policy";
	});
	// The policy edit on its way to a proposal and accepting decision.
	const [switching, setSwitching] = useState<PolicyChange | null>(null);
	const policyAttempt = useRef<{ key: string; propose: string; decide: string } | null>(null);
	const [policyMessage, setPolicyMessage] = useState("");
	const admin = session.can.includes("admin");
	const mayChangePolicy = admin && session.kind === "human" && session.can.includes("produce");
	const instanceAdmin = instanceCan.includes("admin");
	const currentProject = session.projects.find((p) => p.key === project);
	const mayRead = session.can.includes("read");
	const policyRead = useQueryOp({
		project,
		op: "admin",
		input: { do: "policy.show", project },
		enabled: instanceAdmin && mayRead,
	});
	const parsedPolicy = PolicySnapshot.safeParse(policyRead.data);
	const policy = parsedPolicy.success ? parsedPolicy.data : null;
	// The name is a preset's only while the clauses are that preset's. The session's name is checked by the server;
	// the clauses, which only an instance admin reads, are checked here.
	const preset = policy
		? (presetOf(policy) ?? "custom")
		: (session.projects.find((p) => p.key === project)?.policy ?? "Policy unavailable");
	const inForce = Preset.safeParse(preset).data ?? null;
	const unlinked = policy?.settings.unlinked ?? currentProject?.unlinked ?? null;
	const switchingPreset = switching && "preset" in switching ? switching.preset : null;
	const switchingUnlinked = switching && "unlinked" in switching ? switching.unlinked : null;
	const actorRef = useRef<HTMLInputElement>(null);
	const projectRef = useRef<HTMLInputElement>(null);
	const inviteRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const sections = sectionsFor({ kind: session.kind, instanceAdmin });
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
		// Each is registered only for a caller who has the section, so the keys sheet does not list it for one
		// who has not.
		...(sections.includes("People")
			? [
					{
						key: "n",
						label: "New invitation",
						when: () => !overlayOpen && section === "People",
						handler: () => inviteRef.current?.focus(),
					},
				]
			: []),
		...(sections.includes("Your sign-in") && session.via === "cookie"
			? [
					{
						key: "n",
						label: "New password",
						when: () => !overlayOpen && section === "Your sign-in",
						handler: () => passwordRef.current?.focus(),
					},
				]
			: []),
	]);
	async function changePolicy(change: PolicyChange, changeReason?: string): Promise<boolean> {
		if (!mayChangePolicy || switching) return false;
		if (("preset" in change && change.preset === preset) || ("unlinked" in change && change.unlinked === unlinked))
			return false;
		const name =
			"preset" in change
				? `${change.preset} policy`
				: "unlinked" in change
					? `"${UNLINKED_LABELS[change.unlinked]}"`
					: "clauses" in change
						? "custom policy"
						: "custom field definitions";
		const reason =
			changeReason ??
			("preset" in change
				? `Use the ${change.preset} preset, selected in Settings.`
				: "unlinked" in change
					? `Tests with no case: ${change.unlinked}, selected in Settings.`
					: "clauses" in change
						? "Custom policy, edited in Settings."
						: "Change custom field definitions in Settings.");
		const conflictMessage =
			"clauses" in change
				? policyConflictMessage
				: "settings" in change
					? "The policy changed while you edited. Your field draft is kept. Review the current policy and try saving again."
					: "The policy changed before this selection was saved. Review the current policy and choose again.";
		const basedChange = { ...(policy ? { base: policy.version } : {}), ...change };
		const key = JSON.stringify({ change: basedChange, reason });
		if (policyAttempt.current?.key !== key) policyAttempt.current = { key, propose: randomId(), decide: randomId() };
		const attempt = policyAttempt.current;
		setSwitching(change);
		setPolicyMessage(`Recording the ${name} proposal and decision…`);
		try {
			const proposed = await call(
				"propose",
				{
					edits: [{ op: "policy", ...basedChange }],
					reason,
					cmd: attempt.propose,
				},
				{ project },
			);
			if (!proposed.question) throw new Error("The policy proposal did not return a review question.");
			const question = z
				.object({ q: z.string(), evidenceHash: z.string() })
				.parse((await call("get", { refs: [proposed.question] }, { project }))[0]);
			const replies = await call(
				"decide",
				{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" }, reason, cmd: attempt.decide },
				{ project },
			);
			if (replies[0]?.status === "conflict") throw new Error(conflictMessage);
			if (replies[0]?.status !== "decided" && replies[0]?.status !== "already")
				throw new Error(`Policy is awaiting ${replies[0]?.needs ?? "review"}. Open ${question.q} in Queue.`);
			const ruled = z.object({ ruled: z.number() }).safeParse(replies[0]?.effects).data?.ruled ?? 0;
			const answered =
				ruled > 0 ? ` The rule answered ${ruled} open question${ruled === 1 ? "" : "s"} about tests with no case.` : "";
			setPolicyMessage(
				`${"preset" in change ? `${change.preset} is in force.` : "unlinked" in change ? `Tests with no case: ${UNLINKED_LABELS[change.unlinked]}.` : "clauses" in change ? "Custom policy is in force." : "Custom field definitions are in force."}${answered} Proposal ${proposed.proposal} and decision ${question.q} are both recorded.`,
			);
			setStatus(`${name} recorded through ${proposed.proposal} and ${question.q}.`);
			await invalidateProject(project);
			await refreshSession();
			policyAttempt.current = null;
			return true;
		} catch (error) {
			const message =
				error instanceof ApiError && error.code === "conflict"
					? conflictMessage
					: error instanceof Error
						? error.message
						: "The policy could not be changed.";
			setPolicyMessage(message);
			setStatus(message);
			return false;
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
					{section === "Your home" && <YourHome />}
					{!mayRead && <p role="status">Your session may not read this project.</p>}
					{section === "Policy" && mayRead && currentProject && (
						<>
							<div className="settings-policy-head">
								<div>
									<h2>{preset}</h2>
									<p className="dim">
										The policy decides whose answers count. <DocLink page="policy">How policies work</DocLink>
									</p>
									<p className="settings-preset-summary">
										{inForce
											? PRESET_SUMMARY[inForce]
											: "This project has a custom policy. Its clause table says who answers, and an instance admin can read it."}
									</p>
								</div>
								<label>
									Preset{" "}
									<Select
										className="form-input"
										aria-label="Policy preset"
										value={switchingPreset ?? preset}
										disabled={!mayChangePolicy || Boolean(switching)}
										onChange={(event) => {
											void changePolicy({ preset: event.target.value });
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
									</Select>
								</label>
							</div>
							<PresetGuide marked={inForce} as="in force" />
							{/* A switch between two presets says nothing true of a policy that is neither, also while it changes. */}
							{inForce && (
								<label className="settings-agent-toggle">
									<input
										type="checkbox"
										role="switch"
										aria-checked={(switchingPreset ?? preset) !== "loose"}
										checked={(switchingPreset ?? preset) !== "loose"}
										disabled={!mayChangePolicy || Boolean(switching)}
										onChange={(event) => void changePolicy({ preset: event.target.checked ? "standard" : "loose" })}
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
							{/* A custom policy's clauses may not read the setting, so the choice is offered under a preset only. */}
							{inForce && unlinked && (
								<label className="settings-unlinked">
									<span>
										<b>Tests with no case</b>
										<small>{UNLINKED_HELP[switchingUnlinked ?? unlinked]}</small>
									</span>
									<Select
										className="form-input"
										aria-label="Tests with no case"
										value={switchingUnlinked ?? unlinked}
										disabled={!mayChangePolicy || Boolean(switching)}
										onChange={(event) => {
											const chosen = Unlinked.safeParse(event.target.value);
											if (chosen.success) void changePolicy({ unlinked: chosen.data });
										}}
									>
										{Unlinked.options.map((value) => (
											// Under `strict` a person adopts every new case, so a rule cannot make one.
											<option key={value} value={value} disabled={value === "create" && inForce === "strict"}>
												{UNLINKED_LABELS[value]}
											</option>
										))}
									</Select>
								</label>
							)}
							<p className="dim">
								Changing policy here needs a person with produce and admin on this project. An instance admin can read
								the clause table; editing it also needs those project permissions. Applying records a proposal and an
								accepting decision.
							</p>
							<p className="settings-message" role="status">
								{policyMessage}
							</p>
							{policyRead.error && <p role="status">{policyRead.error.message}</p>}
							{policy && (
								<>
									<CustomFields
										key={project}
										definitions={policy.settings.fields ?? {}}
										disabled={!mayChangePolicy || Boolean(switching)}
										onSave={(fields) =>
											changePolicy({ base: policy.version, settings: { ...policy.settings, fields } })
										}
									/>
									<PolicyEditor
										policy={policy}
										project={project}
										mayChange={mayChangePolicy}
										busy={Boolean(switching)}
										onApply={changePolicy}
									/>
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
									<p className="dim">
										Same-code detector: {policy.settings.flakyDetection.enabled ? "on" : "off"} ·{" "}
										{policy.settings.flakyDetection.minFlips} outcome changes per test and failure cause in{" "}
										{policy.settings.flakyDetection.windowDays} days suggest investigation. Suggestions excuse no
										failure. Change these settings through a <DocLink page="policy">policy edit</DocLink>.
									</p>
									<QuarantineList />
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
					{section === "People" && <People nameRef={inviteRef} />}
					{section === "Your sign-in" && <YourSignIn passwordRef={passwordRef} />}
					{section === "Your sessions" && <YourSessions />}
					{section === "Projects" && <ProjectSettings inputRef={projectRef} />}
					{section === "Connect" && (
						<>
							<h2>Connect a pipeline</h2>
							<p>Report the runner's JUnit XML, then read the gate.</p>
							<pre className="settings-command">{`MAINWORTHY_URL=${location.origin}\nMAINWORTHY_PROJECT=${project}\nmainworthy report results/*.xml\nmainworthy gate`}</pre>
							<p className="dim">
								Set MAINWORTHY_TOKEN to a pipeline token in the runner's secret store. A pipeline token records results
								and reads the gate; it cannot read the suite or change a case. Where the policy creates a case for each
								test with none, its reports add those cases.{" "}
								<DocLink page="report-results">How to report results</DocLink>
							</p>
							<SectionHeading>Connect an agent</SectionHeading>
							<p>Create an agent token with read and produce permissions. Under standard, edits wait for a person.</p>
							<pre className="settings-command">{`${location.origin}/mcp`}</pre>
							<p className="dim">
								Send the token as a Bearer authorization header to the MCP endpoint.{" "}
								<DocLink page="agents">How to let an agent in</DocLink>
							</p>
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
	const [actor, setActor] = useState("");
	const [kind, setKind] = useState<"human" | "agent" | "ci">("agent");
	const [capabilities, setCapabilities] = useState<z.infer<typeof Capability>[]>([...defaultCapabilities("agent")]);
	const [expires, setExpires] = useState<(typeof LIFETIMES)[number]["value"]>("");
	const [created, setCreated] = useState<z.infer<typeof CreatedToken> | null>(null);
	const secretRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<h2>Tokens</h2>
			<p className="dim">
				A token identifies its producer and is limited to this project.{" "}
				<DocLink page="access">People, agents and pipelines</DocLink>
			</p>
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
							...(expires ? { expires } : {}),
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
				<Select
					className="form-input"
					id="token-kind"
					value={kind}
					onChange={(event) => {
						const chosen = z.enum(["human", "agent", "ci"]).parse(event.target.value);
						setKind(chosen);
						// Each producer starts from what its kind is for; a pipeline records and nothing else.
						setCapabilities([...defaultCapabilities(chosen)]);
					}}
				>
					<option value="agent">Agent</option>
					<option value="ci">Pipeline</option>
					<option value="human">Person</option>
				</Select>
				<fieldset className="settings-capabilities">
					<legend>Permissions</legend>
					{(kind === "ci" ? CI_CAPABILITIES : Capability.options).map((can) => (
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
				<label htmlFor="token-expires">Expires</label>
				<Select
					className="form-input"
					id="token-expires"
					value={expires}
					onChange={(event) => {
						const chosen = LIFETIMES.find((lifetime) => lifetime.value === event.target.value);
						if (chosen) setExpires(chosen.value);
					}}
				>
					{LIFETIMES.map((lifetime) => (
						<option key={lifetime.value} value={lifetime.value}>
							{lifetime.label}
						</option>
					))}
				</Select>
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
			<IssuedTokens canCreate />
		</>
	);
}
function ProjectSettings({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
	const { session, instanceCan, project, route, refreshSession, setStatus } = useApp();
	const [key, setKey] = useState("");
	const [name, setName] = useState("");
	const [preset, setPreset] = useState<Preset>("loose");
	const [busy, setBusy] = useState(false);
	return (
		<>
			<h2>Projects</h2>
			<p className="dim">
				Each project has its own cases, queue and policy. <DocLink page="customize">What you can customize</DocLink>
			</p>
			{session.projects.map((p) => (
				<button
					className="settings-project"
					key={p.key}
					type="button"
					aria-pressed={project === p.key}
					onClick={() => navigate(projectUrl({ project: p.key, screen: route.screen }))}
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
						<Select
							className="form-input"
							id="project-preset"
							aria-describedby="project-preset-help"
							value={preset}
							onChange={(event) => {
								setPreset(Preset.parse(event.target.value));
							}}
						>
							{Preset.options.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</Select>
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
