import { useState } from "react";
import { Capability } from "../../core/kinds.ts";
import { TeamChanged, TeamRow } from "../../core/team-replies.ts";
import type { TeamInput } from "../../core/teams.ts";
import { call } from "../lib/api.ts";
import { randomId } from "../lib/ids.ts";
import { useApp } from "../ui/context.tsx";
import { SectionHeading, Select } from "../ui/index.tsx";
import { saidBy, saidOfWrite, useList } from "./list.ts";
import { useRecentProof } from "./recent-proof.tsx";

export function Teams({ people, changed }: { people: readonly string[]; changed: () => Promise<unknown> }) {
	const { session, project } = useApp();
	const proof = useRecentProof();
	const teams = useList("teams", async ({ signal }) =>
		TeamRow.array().parse(await call("admin", { do: "team.list" }, { project, signal })),
	);
	const [name, setName] = useState("");
	const [selected, setSelected] = useState("");
	const [person, setPerson] = useState("");
	const [onProject, setOnProject] = useState("");
	const [can, setCan] = useState<Capability[]>([]);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const team = teams.data?.find((row) => row.name === selected);
	const ownTeam = team?.members.includes(session.actor) ?? false;

	async function send(input: TeamInput): Promise<void> {
		if (busy) return;
		setBusy(true);
		setMessage("");
		try {
			TeamChanged.parse(await proof.run(() => call("admin", input, { project })));
			setMessage("Team updated.");
			if (input.do === "team.create") {
				setName("");
				setSelected(input.name);
			} else if (input.do === "team.member.add") {
				setPerson("");
			}
		} catch (error) {
			setMessage(
				saidOfWrite(
					error,
					"No readable answer came back, so the page cannot tell whether the team changed. The lists are read again; check them before sending another change.",
				),
			);
		} finally {
			await Promise.all([teams.refetch(), changed()]);
			setBusy(false);
		}
	}

	return (
		<section aria-label="Teams">
			<SectionHeading>Teams</SectionHeading>
			{proof.prompt}
			<p className="dim">
				A person's own grants and their teams' grants add up. Removing a membership takes away that team's grants at
				once. Teams grant permissions only. Assign named roles on each person's own grant. Another admin changes your
				membership and the grants of teams you belong to.
			</p>
			<form
				className="settings-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (name.trim()) void send({ do: "team.create", name: name.trim(), cmd: randomId() });
				}}
			>
				<label htmlFor="team-name">New team name</label>
				<input
					id="team-name"
					className="form-input"
					value={name}
					readOnly={busy}
					maxLength={64}
					required
					onChange={(event) => setName(event.target.value)}
				/>
				<button type="submit" className="out" aria-disabled={busy || !name.trim()}>
					Create team
				</button>
			</form>
			{teams.error && <p role="status">{saidBy(teams.error)}</p>}
			<label htmlFor="team-selected">Team to manage</label>
			<Select
				id="team-selected"
				className="form-input"
				value={selected}
				onChange={(event) => {
					setSelected(event.target.value);
					setPerson("");
					setCan([]);
					setMessage("");
				}}
			>
				<option value="">Choose a team</option>
				{teams.data?.map((row) => (
					<option key={row.name} value={row.name}>
						{row.name}
					</option>
				))}
			</Select>
			{team && (
				<>
					<h3>{team.name}</h3>
					{team.grants.length === 0 && <p className="dim">This team has no grants.</p>}
					{team.grants.map((grant) => (
						<div className="settings-row" key={grant.project}>
							<span>
								{grant.project === "*" ? "Every project" : grant.project}: {grant.can.join(", ")}
							</span>
							<button
								type="button"
								className="out"
								aria-disabled={busy || ownTeam}
								aria-label={`Remove ${grant.project} grant from ${team.name}`}
								onClick={() => {
									if (!ownTeam)
										void send({
											do: "team.grant.remove",
											team: team.name,
											...(grant.project === "*" ? {} : { project: grant.project }),
											cmd: randomId(),
										});
								}}
							>
								Remove grant
							</button>
						</div>
					))}
					<form
						className="settings-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (!ownTeam && can.length)
								void send({
									do: "team.grant.set",
									team: team.name,
									...(onProject ? { project: onProject } : {}),
									can,
									cmd: randomId(),
								});
						}}
					>
						<label htmlFor="team-project">Grant on</label>
						<Select
							id="team-project"
							className="form-input"
							value={onProject}
							onChange={(event) => setOnProject(event.target.value)}
						>
							<option value="">Every project</option>
							{session.projects.map((row) => (
								<option key={row.key} value={row.key}>
									{row.name}
								</option>
							))}
						</Select>
						<fieldset className="settings-capabilities">
							<legend>Team permissions</legend>
							{Capability.options.map((capability) => (
								<label key={capability}>
									<input
										type="checkbox"
										checked={can.includes(capability)}
										onChange={(event) =>
											setCan((now) =>
												event.target.checked ? [...now, capability] : now.filter((value) => value !== capability),
											)
										}
									/>
									{capability}
								</label>
							))}
						</fieldset>
						<p className="dim settings-hint">
							Set grant replaces this team's grant on the chosen project. admin on every project lets every member
							administer the instance.
						</p>
						<button type="submit" className="out" aria-disabled={busy || ownTeam || can.length === 0}>
							Set team grant
						</button>
					</form>
					{team.members.length === 0 && <p className="dim">This team has no members.</p>}
					{team.members.map((member) => (
						<div className="settings-row" key={member}>
							<span>{member}</span>
							<button
								type="button"
								className="out"
								aria-disabled={busy || member === session.actor}
								aria-label={`Remove ${member} from ${team.name}`}
								onClick={() => {
									if (member !== session.actor)
										void send({ do: "team.member.remove", team: team.name, person: member, cmd: randomId() });
								}}
							>
								Remove member
							</button>
						</div>
					))}
					<form
						className="settings-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (person) void send({ do: "team.member.add", team: team.name, person, cmd: randomId() });
						}}
					>
						<label htmlFor="team-person">Person to add</label>
						<Select
							id="team-person"
							className="form-input"
							value={person}
							onChange={(event) => setPerson(event.target.value)}
						>
							<option value="">Choose a person</option>
							{people
								.filter((name) => name !== session.actor && !team.members.includes(name))
								.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
						</Select>
						<button type="submit" className="out" aria-disabled={busy || !person}>
							Add team member
						</button>
					</form>
				</>
			)}
			<p className="settings-message" role="status">
				{message}
			</p>
		</section>
	);
}
