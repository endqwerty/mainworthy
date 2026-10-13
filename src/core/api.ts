// The operations as a client sees them: each name with its input and its reply. The web client and the CLI are
// typed from this map, so a call site that sends the wrong shape does not compile.
import type { z } from "zod";
import type { Unlinked } from "./kinds.ts";
import type {
	AdminInput,
	ChangeInput,
	ChangeReply,
	CheckInput,
	ClaimInput,
	ClaimReply,
	CommandFate,
	CommandInput,
	DecideInput,
	DecideReply,
	FindInput,
	GateInput,
	GateStatus,
	GetInput,
	HistoryInput,
	ImpactInput,
	InboxInput,
	InboxReply,
	PlanInput,
	PlanReply,
	Problem,
	ProposeInput,
	ProposeReply,
	ReportInput,
	ReportReceipt,
	SinceInput,
	TimelineInput,
} from "./ops.ts";
import type {
	CredentialInput,
	CredentialRow,
	CredentialSummary,
	InvitationCreated,
	InvitationInput,
	InvitationRow,
	SessionInput,
	SessionRow,
} from "./people.ts";

type In<S extends z.ZodType> = z.input<S>;
type Rows = Record<string, unknown>[];

export type Api = {
	propose: { input: In<typeof ProposeInput>; reply: ProposeReply };
	report: { input: In<typeof ReportInput>; reply: ReportReceipt };
	claim: { input: In<typeof ClaimInput>; reply: ClaimReply };
	plan: { input: In<typeof PlanInput>; reply: PlanReply };
	change: { input: In<typeof ChangeInput>; reply: ChangeReply };
	decide: { input: In<typeof DecideInput>; reply: DecideReply[] };
	inbox: { input: In<typeof InboxInput>; reply: InboxReply };
	get: { input: In<typeof GetInput>; reply: Rows };
	find: {
		input: In<typeof FindInput>;
		/** `count` is null when it is not known: a page of a list, or a search too broad to count. */
		reply: { count: number | null; items: Rows; cursor: string | null };
	};
	impact: { input: In<typeof ImpactInput>; reply: Record<string, unknown> };
	since: { input: In<typeof SinceInput>; reply: { changed: Rows; settled: Rows; cursor: string } };
	gate: { input: In<typeof GateInput>; reply: GateStatus };
	history: { input: In<typeof HistoryInput>; reply: Record<string, unknown> };
	timeline: {
		input: In<typeof TimelineInput>;
		reply: { ref: string; head: number; entries: Rows; questions: InboxReply["items"] };
	};
	check: { input: In<typeof CheckInput>; reply: { problems: Problem[]; counts: Record<string, number> } };
	command: { input: In<typeof CommandInput>; reply: CommandFate };
	admin: { input: In<typeof AdminInput>; reply: unknown };
	/** `list`: `SessionRow[]`. `end`: `{ ended: true, current }`, where `current` says it was the caller's own. */
	session: { input: In<typeof SessionInput>; reply: SessionRow[] | { ended: true; current: boolean } };
	/**
	 * `list`: `CredentialRow[]`. `passkey.begin`: the options for `navigator.credentials.create`. `passkey.add`:
	 * `{ id, label }`. `remove`: `{ removed: true, sessionsEnded }`.
	 */
	credential: { input: In<typeof CredentialInput>; reply: CredentialRow[] | Record<string, unknown> };
	/** `create`: `InvitationCreated`. `list`: `InvitationRow[]`. `revoke`: `{ revoked }`. */
	invitation: {
		input: In<typeof InvitationInput>;
		reply: InvitationCreated | InvitationRow[] | { revoked: boolean };
	};
};
export type OpName = keyof Api;

/**
 * The operations that are the instance's and not a project's: a client sends these to `/api/<op>`, the one
 * address that answers them, and every other one to `/api/p/<project>/<op>`. The registry is where an
 * operation's scope is declared; this list is for a client that cannot import the registry (the web UI), and
 * a test holds the two equal (`test/web-client.test.ts`).
 */
export const INSTANCE_OPS = ["admin", "session", "credential", "invitation"] as const satisfies readonly OpName[];

/**
 * Why a request did not run. `conflict` is a stale base or a duplicate; a rule that says no is `forbidden`;
 * `limited` is a caller that failed to prove itself too often, and is told how long to wait.
 *
 * This is the one place the codes are written. The server's replies, the API description and the schemas with
 * which the CLI, the web client and the reader threads read a reply all take this list, so a code added here is
 * one every client can read (`test/architecture.test.ts` fails on a second copy).
 */
export const ERROR_CODES = [
	"invalid",
	"unauthenticated",
	"forbidden",
	"not_found",
	"conflict",
	"limited",
	"internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP status of a reply that carries each code. */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
	invalid: 400,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	limited: 429,
	internal: 500,
};

/** The envelope every operation replies with over HTTP. */
export type Envelope<T> =
	| { ok: true; result: T; seq: number | null }
	| {
			ok: false;
			error: {
				code: ErrorCode;
				message: string;
				details?: Record<string, unknown> | undefined;
			};
	  };

/**
 * What the session endpoint returns: who the caller is and the projects it may read. `can` at the top is what the
 * caller may do on the instance (create projects, issue tokens); each project carries what it may do there, which
 * is what a screen must ask about. A token limited to one project has nothing at the top.
 */
export type SessionInfo = {
	actor: string;
	kind: "human" | "agent" | "ci" | "rule";
	can: string[];
	mode: "local" | "server";
	via: "token" | "cookie" | "local";
	/** The id of the browser session the request came by (`via: "cookie"`), else null. It marks one row of `session list`. */
	session: number | null;
	/** How the caller signs in, when the caller is a person; null for an agent or a pipeline. */
	credentials: CredentialSummary | null;
	/**
	 * Whether the caller is the owner of the instance: the person its configuration names. The owner alone makes
	 * a token or a recovery link for another person who exists, so a page offers those where this is true.
	 */
	owner: boolean;
	version: string;
	projects: {
		key: string;
		name: string;
		seq: number;
		createdAt: number;
		policy: string;
		/** What happens to a test with no case. Absent only in the reply of a server older than the setting. */
		unlinked?: Unlinked | undefined;
		can?: string[];
	}[];
};
