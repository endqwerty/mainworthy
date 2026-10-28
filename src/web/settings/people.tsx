import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { z } from "zod";
import { Capability, defaultCapabilities } from "../../core/kinds.ts";
import { INVITATION_LASTS, type InvitationCreated, type InvitationRow } from "../../core/people-replies.ts";
import { TeamSource } from "../../core/team-replies.ts";
import { copySecret } from "../lib/clipboard.ts";
import { queryKey, useQueryOp } from "../lib/data.ts";
import { createInvitation, dateTime, listInvitations, revokeInvitation, until } from "../lib/people.ts";
import { signInMethods } from "../lib/signin.ts";
import { useApp } from "../ui/context.tsx";
import { age, DocLink, ProducerGlyph, SectionHeading, Select } from "../ui/index.tsx";
import { InlineConfirmation } from "./inline-confirmation.tsx";
import { saidBy, saidOfWrite, useList, withId } from "./list.ts";
import { PersonAccess } from "./people-access.tsx";
import { ForgetPerson } from "./people-forget.tsx";
import { useRecentProof } from "./recent-proof.tsx";
import { Teams } from "./teams.tsx";
import { IssuedTokens } from "./tokens.tsx";
import "./people.css";

const Actor = z.object({
	name: z.string(),
	kind: z.string(),
	disabled: z.boolean(),
	owner: z.boolean().optional(),
	teams: z.array(TeamSource).default([]),
	grants: z.array(z.object({ project: z.string(), can: z.array(z.string()), roles: z.array(z.string()).default([]) })),
});
/** How long a link may last, as the form offers it. The server takes any duration up to thirty days. */
const LASTS: readonly [string, string][] = [
	["12h", "12 hours"],
	["1d", "1 day"],
	["3d", "3 days"],
	["1w", "1 week"],
	["2w", "2 weeks"],
	["30d", "30 days"],
];
const where = (project: string): string => (project === "*" ? "every project" : project);
/** What a person holds, grant by grant: "every project: read, answer". */
const held = (grants: readonly { project: string; can: readonly string[]; roles?: readonly string[] }[]): string =>
	grants.length === 0
		? "no grant"
		: grants
				.map(
					(grant) =>
						`${where(grant.project)}: ${grant.can.join(", ")}${grant.roles?.length ? `; roles: ${grant.roles.join(", ")}` : ""}`,
				)
				.join("; ");
/**
 * What a new invitation starts with: what a person needs to work. `admin` is for the inviter to tick, because
 * whoever holds it on every project invites people, makes tokens and changes what others may do.
 */
const STARTS_WITH: readonly Capability[] = defaultCapabilities("human").filter((capability) => capability !== "admin");

/**
 * Who signs in to this instance, for an admin who is a person. An admin makes a link and hands it over. A new
 * name gets an invitation to join; a person who exists gets a recovery link, which replaces the identities they
 * sign in with once they accept it.
 */
export function People({ nameRef }: { nameRef: RefObject<HTMLInputElement | null> }) {
	const { project, session } = useApp();
	const proof = useRecentProof();
	const client = useQueryClient();
	const methods = useQuery({ queryKey: ["instance", "sign-in-methods"], queryFn: signInMethods, staleTime: Infinity });
	const invitations = useList("invitation", listInvitations);
	const actors = useQueryOp({ project, op: "admin", input: { do: "actor.list" } });
	const listed = Actor.array().safeParse(actors.data);
	const people = listed.success ? listed.data.filter((actor) => actor.kind === "human" && !actor.disabled) : [];
	// The links that were made and not dismissed yet. They are in this component's memory only: leaving the
	// section drops them, and nothing shows one again.
	const [created, setCreated] = useState<readonly InvitationCreated[]>([]);
	const [name, setName] = useState("");
	const [can, setCan] = useState<Capability[]>([...STARTS_WITH]);
	const [onProject, setOnProject] = useState("");
	const [expires, setExpires] = useState<string>(INVITATION_LASTS.default);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	const [revoking, setRevoking] = useState<ReadonlySet<number>>(new Set());
	// The person a recovery link is about to be made for, and the person a request is under way for.
	const [confirming, setConfirming] = useState<string | null>(null);
	const [recovering, setRecovering] = useState<string | null>(null);
	const [refusal, setRefusal] = useState<{ about: string; message: string } | null>(null);
	const [message, setMessage] = useState("");
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// A recovery link makes whoever accepts it that person. The server lets a person make their own, and the
	// owner of the instance anybody's; the button is where the server will say yes.
	const mayRecover = (person: string): boolean => session.owner || person === session.actor;
	const wanted = name.trim();
	const exists = people.some((person) => person.name === wanted);
	const open = invitations.data?.filter((row) => row.state === "open") ?? [];
	const made = (link: InvitationCreated): Promise<void> => {
		// A new invitation for a person revokes their earlier one, so a link for them that is still on the page
		// works no more and goes. A link for somebody else stays until it is dismissed: it cannot be shown again.
		setCreated((links) => [...links.filter((earlier) => earlier.name !== link.name), link]);
		return Promise.all([invitations.refetch(), actors.refetch()]).then(() => {});
	};

	function invite(event: FormEvent): void {
		event.preventDefault();
		if (busy || !wanted || exists || can.length === 0) return;
		setBusy(true);
		setProblem("");
		void proof
			.run(() =>
				createInvitation({
					name: wanted,
					expires,
					grant: { can, project: onProject || null },
				}),
			)
			.then((link) => {
				setName("");
				// The next person does not get `admin` because this one did.
				setCan((now) => now.filter((capability) => capability !== "admin"));
				return made(link);
			})
			.catch((error: unknown) => {
				setProblem(
					saidOfWrite(
						error,
						`No readable answer came back, so the page cannot tell whether ${wanted} was invited. The lists below are read again. If ${wanted} is in them, that link is lost: a recovery link is their way in.`,
					),
				);
				void Promise.all([invitations.refetch(), actors.refetch()]);
			})
			.finally(() => setBusy(false));
	}

	function recover(person: string): void {
		if (recovering) return;
		setRecovering(person);
		setRefusal(null);
		void proof
			.run(() => createInvitation({ name: person, expires: INVITATION_LASTS.default, grant: null }))
			.then((link) => {
				setConfirming(null);
				return made(link);
			})
			// The button is not offered where the server would refuse; what it refuses all the same is said here.
			.catch((error: unknown) => {
				setRefusal({
					about: person,
					message: saidOfWrite(
						error,
						"No readable answer came back. If a link was made it is lost, and making another takes its place.",
					),
				});
				void invitations.refetch();
			})
			.finally(() => setRecovering(null));
	}

	function revoke(row: InvitationRow): void {
		if (revoking.has(row.id)) return;
		setRevoking((ids) => withId(ids, row.id, true));
		setMessage("");
		void revokeInvitation(row.id)
			.then(({ revoked }) => {
				setMessage(
					revoked
						? `The invitation for ${row.name} was revoked.`
						: `The invitation for ${row.name} was used or revoked already.`,
				);
				return invitations.refetch();
			})
			.catch((error: unknown) => {
				setMessage(saidBy(error));
				// With no reply it may have been revoked all the same: the list says.
				void invitations.refetch();
			})
			.finally(() => setRevoking((ids) => withId(ids, row.id, false)));
	}

	return (
		<>
			<h2>People</h2>
			{proof.prompt}
			<p className="dim">
				You make a link and hand it to the person; it works once, and they accept it by signing in with the instance's
				identity provider. <DocLink page="access">How a person gets in</DocLink>
			</p>
			{methods.data && !methods.data.oidc && (
				<p className="dim">
					This instance has no identity provider, so an invitation cannot be accepted here. Whoever runs it sets one up
					first.
				</p>
			)}
			<form className="settings-form" onSubmit={invite}>
				<label htmlFor="invite-name">Name</label>
				<input
					className="form-input"
					id="invite-name"
					ref={nameRef}
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={64}
					autoCapitalize="none"
					spellCheck={false}
					placeholder="robin"
					required
				/>
				<p className="settings-problem" role="status">
					{exists && `${wanted} signs in here already. A recovery link is made from their row below.`}
				</p>
				<fieldset className="settings-capabilities">
					<legend>What they may do</legend>
					{Capability.options.map((capability) => (
						<label key={capability}>
							<input
								type="checkbox"
								checked={can.includes(capability)}
								aria-describedby={capability === "admin" ? "invite-admin-help" : undefined}
								onChange={(event) =>
									setCan((now) =>
										event.target.checked ? [...now, capability] : now.filter((entry) => entry !== capability),
									)
								}
							/>
							{capability}
						</label>
					))}
				</fieldset>
				<p className="dim settings-hint" id="invite-admin-help">
					admin lets a person change the policy, and on every project also invite people, make tokens and projects, and
					change what others may do. It starts unticked.
				</p>
				<label htmlFor="invite-project">On</label>
				<Select
					className="form-input"
					id="invite-project"
					value={onProject}
					onChange={(event) => setOnProject(event.target.value)}
				>
					<option value="">Every project</option>
					{session.projects.map((entry) => (
						<option key={entry.key} value={entry.key}>
							{entry.name}
						</option>
					))}
				</Select>
				<label htmlFor="invite-expires">The link works for</label>
				<Select
					className="form-input"
					id="invite-expires"
					value={expires}
					onChange={(event) => setExpires(event.target.value)}
				>
					{LASTS.map(([value, text]) => (
						<option key={value} value={value}>
							{text}
						</option>
					))}
				</Select>
				<p className="settings-problem" role="status">
					{problem}
				</p>
				{/* Marked and never disabled, so it keeps the focus through a request: `invite` sends nothing it should not. */}
				<button className="out" type="submit" aria-disabled={busy || !wanted || exists || can.length === 0}>
					{busy ? "Making the link…" : "Make invitation link"}
				</button>
			</form>
			{created.map((link) => (
				<InvitationLink
					key={link.id}
					created={link}
					dismiss={() => {
						setCreated((links) => links.filter((shown) => shown.id !== link.id));
						// The button that was pressed is gone with the link. The keys go to the name, for the next person.
						nameRef.current?.focus();
					}}
				/>
			))}

			<SectionHeading>Open invitations</SectionHeading>
			{invitations.error && <p role="status">{saidBy(invitations.error)}</p>}
			{open.map((row) => (
				<div className="settings-row" key={row.id}>
					<span>
						<b>{row.name}</b>
						<small>
							{row.purpose === "join" ? "to join" : "recovery"} · {held(row.grants)} · made by {row.createdBy}{" "}
							{age(row.createdAt)} · runs out in {until(row.expiresAt)}
						</small>
					</span>
					<button
						className="out"
						type="button"
						aria-disabled={revoking.has(row.id)}
						aria-label={`Revoke the invitation for ${row.name}`}
						onClick={() => revoke(row)}
					>
						{revoking.has(row.id) ? "Revoking…" : "Revoke"}
					</button>
				</div>
			))}
			{invitations.data && open.length === 0 && <p className="dim">No open invitations.</p>}
			<p className="settings-message" role="status">
				{message}
			</p>

			<SectionHeading>People who sign in</SectionHeading>
			{!session.owner && (
				<p className="dim">
					You make a recovery link for yourself. For anybody else the owner of the instance makes it: whoever accepts
					one is that person from then on.
				</p>
			)}
			{actors.error && <p role="status">{saidBy(actors.error)}</p>}
			{people.map((person) => (
				<div key={person.name}>
					<div className="settings-row">
						<ProducerGlyph kind="human" />
						<span>
							<b>{person.name}</b>
							<small>Own grants: {held(person.grants)}</small>
							{person.teams.map((team) => (
								<small key={team.name}>
									From team {team.name}: {held(team.grants)}
								</small>
							))}
							{confirming === person.name && (
								<small>
									A recovery link is for somebody who cannot sign in with their identity any more. Once {person.name}{" "}
									accepts it, it replaces their identities and tokens and ends their sessions.
								</small>
							)}
							<small className="settings-refusal" role="status">
								{refusal?.about === person.name ? refusal.message : ""}
							</small>
						</span>
						<button
							className="out"
							type="button"
							aria-label={`Sign-in details for ${person.name}`}
							aria-expanded={expanded.has(person.name)}
							onClick={() =>
								setExpanded((now) => {
									const next = new Set(now);
									if (next.has(person.name)) next.delete(person.name);
									else next.add(person.name);
									return next;
								})
							}
						>
							Sign-in details
						</button>
						{mayRecover(person.name) && (
							<InlineConfirmation
								open={confirming === person.name}
								trigger="Recovery link"
								triggerLabel={`Recovery link for ${person.name}`}
								confirm={recovering === person.name ? "Making the link…" : "Make the recovery link"}
								busy={recovering !== null}
								onOpen={() => {
									setRefusal(null);
									setConfirming(person.name);
								}}
								onCancel={() => setConfirming(null)}
								onConfirm={() => recover(person.name)}
							/>
						)}
					</div>
					{expanded.has(person.name) && <PersonAccess actor={person.name} />}
				</div>
			))}
			<IssuedTokens />
			<Teams people={people.map((person) => person.name)} changed={() => actors.refetch()} />
			<ForgetPerson
				people={people}
				changed={async (forgotten) => {
					setCreated((links) => links.filter((link) => link.name !== forgotten));
					const [, refreshed] = await Promise.all([
						invitations.refetch(),
						actors.refetch(),
						client.invalidateQueries({ queryKey: queryKey({ project, op: "admin", input: { do: "token.list" } }) }),
					]);
					const list = Actor.array().safeParse(refreshed.data);
					return refreshed.isSuccess && list.success
						? list.data.some((person) => person.name === forgotten && person.kind === "human" && !person.disabled)
						: null;
				}}
			/>
		</>
	);
}

/** A link that was just made, shown once, as a new token is: masked, with a button that copies it. */
function InvitationLink({ created, dismiss }: { created: InvitationCreated; dismiss: () => void }) {
	const field = useRef<HTMLInputElement>(null);
	const [copied, setCopied] = useState("");
	// An instance that was given no public address answers with a path. The address this page was opened at is
	// then the one the admin knows to work.
	const relative = created.link.startsWith("/");
	const address = relative ? `${location.origin}${created.link}` : created.link;
	return (
		<div className="settings-secret settings-invitation">
			<b>
				This link is shown once. Hand it to {created.name}: it works once, until {dateTime(created.expiresAt)}.
			</b>
			<p>
				{created.name} · {created.can.join(", ")} · {where(created.project)}
			</p>
			{created.purpose === "recover" && (
				<p>
					When {created.name} accepts it, the identities and tokens they had stop working and every session of theirs
					ends.
				</p>
			)}
			{relative && (
				<p className="dim">
					This instance was given no public address (MAINWORTHY_PUBLIC_URL), so the link starts with the address you
					opened this page at.
				</p>
			)}
			<input
				className="form-input"
				type="password"
				aria-label={`Invitation link for ${created.name}`}
				readOnly
				value={address}
				ref={field}
			/>
			<div>
				<button
					className="out"
					type="button"
					// biome-ignore lint/a11y/noAutofocus: the link was just asked for and is shown once; copying it is what comes next.
					autoFocus
					onClick={() =>
						void copySecret(field.current, address).then((done) =>
							setCopied(done ? "Link copied." : "Copy failed. Try again."),
						)
					}
				>
					Copy link
				</button>
				<button type="button" className="dim" onClick={dismiss}>
					Dismiss link
				</button>
				<span className="dim" role="status">
					{copied}
				</span>
			</div>
		</div>
	);
}
