// The operations as a client sees them: each name with its input and its reply. The web client and the CLI are
// typed from this map, so a call site that sends the wrong shape does not compile.

import type { z } from "zod";
import type { AttachInput, AttachmentReadInput } from "./attachments.ts";
import type { AuditInput } from "./audit.ts";
import type { CsvImportInput } from "./csv.ts";
import type { HandoffInput, HandoffStatusInput } from "./handoff.ts";
import type { Unlinked } from "./kinds.ts";
import type { FieldDefinitions } from "./model.ts";
import type {
	AdminInput,
	AnnounceInput,
	ChangeInput,
	CheckInput,
	ClaimInput,
	CommandInput,
	DecideInput,
	FindInput,
	GateInput,
	GetInput,
	HistoryInput,
	ImpactInput,
	InboxInput,
	PlanInput,
	ProposeInput,
	ReportInput,
	SinceInput,
	TimelineInput,
	WorkInput,
} from "./ops.ts";
import type { CredentialInput, CredentialSummary, InvitationInput, SessionInput } from "./people.ts";
import type { REPLIES } from "./replies.ts";
import type { StatsInput } from "./stats.ts";
import type { TrackerInput, TrackerStatusInput } from "./tracker.ts";

type In<S extends z.ZodType> = z.input<S>;

type Inputs = {
	attach: In<typeof AttachInput>;
	attachment: In<typeof AttachmentReadInput>;
	audit: In<typeof AuditInput>;
	tracker: In<typeof TrackerInput>;
	"tracker-status": In<typeof TrackerStatusInput>;
	handoff: In<typeof HandoffInput>;
	"handoff-status": In<typeof HandoffStatusInput>;
	announce: In<typeof AnnounceInput>;
	propose: In<typeof ProposeInput>;
	"import-csv": In<typeof CsvImportInput>;
	report: In<typeof ReportInput>;
	claim: In<typeof ClaimInput>;
	plan: In<typeof PlanInput>;
	work: In<typeof WorkInput>;
	change: In<typeof ChangeInput>;
	decide: In<typeof DecideInput>;
	inbox: In<typeof InboxInput>;
	get: In<typeof GetInput>;
	find: In<typeof FindInput>;
	impact: In<typeof ImpactInput>;
	since: In<typeof SinceInput>;
	gate: In<typeof GateInput>;
	history: In<typeof HistoryInput>;
	timeline: In<typeof TimelineInput>;
	check: In<typeof CheckInput>;
	stats: In<typeof StatsInput>;
	command: In<typeof CommandInput>;
	admin: In<typeof AdminInput>;
	session: In<typeof SessionInput>;
	credential: In<typeof CredentialInput>;
	invitation: In<typeof InvitationInput>;
};
export type Api = {
	[K in keyof Inputs]: { input: Inputs[K]; reply: z.output<(typeof REPLIES)[K]> };
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
	"recent_proof_required",
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
	recent_proof_required: 403,
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
	/** Stable identity for device data; a forgotten name can be reused by another actor. */
	actorId: number;
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
	/** `demo`: the project's dates were given by whoever wrote them, not read from the server's clock (decision 0100). */
	projects: {
		key: string;
		identity: string;
		name: string;
		seq: number;
		createdAt: number;
		policy: string;
		/** What happens to a test with no case. Absent only in the reply of a server older than the setting. */
		unlinked?: Unlinked | undefined;
		fieldDefinitions?: FieldDefinitions | undefined;
		demo: boolean;
		can?: string[];
		/** Whether a failure question can be handed to a coding agent (`MAINWORTHY_HANDOFF_*`). */
		handoff: boolean;
	}[];
};
