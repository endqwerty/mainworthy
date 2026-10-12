// The operations as a client sees them: each name with its input and its reply. The web client and the CLI are
// typed from this map, so a call site that sends the wrong shape does not compile.
import type { z } from "zod";
import type {
	AdminInput,
	CheckInput,
	ClaimInput,
	ClaimReply,
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

type In<S extends z.ZodType> = z.input<S>;
type Rows = Record<string, unknown>[];

export type Api = {
	propose: { input: In<typeof ProposeInput>; reply: ProposeReply };
	report: { input: In<typeof ReportInput>; reply: ReportReceipt };
	claim: { input: In<typeof ClaimInput>; reply: ClaimReply };
	plan: { input: In<typeof PlanInput>; reply: PlanReply };
	decide: { input: In<typeof DecideInput>; reply: DecideReply[] };
	inbox: { input: In<typeof InboxInput>; reply: InboxReply };
	get: { input: In<typeof GetInput>; reply: Rows };
	find: {
		input: In<typeof FindInput>;
		reply: { count: number | null; items: Rows; cursor: string | null; tags?: { tag: string; n: number }[] };
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
	admin: { input: In<typeof AdminInput>; reply: unknown };
};
export type OpName = keyof Api;

/** The envelope every operation replies with over HTTP. */
export type Envelope<T> =
	| { ok: true; result: T; seq: number | null }
	| {
			ok: false;
			error: {
				code: "invalid" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "internal";
				message: string;
				details?: Record<string, unknown> | undefined;
			};
	  };

/** What the session endpoint returns: who the caller is and which projects exist. */
export type SessionInfo = {
	actor: string;
	kind: "human" | "agent" | "ci" | "rule";
	can: string[];
	mode: "local" | "server";
	via: "token" | "cookie" | "local";
	version: string;
	projects: { key: string; name: string; seq: number; createdAt: number; policy: string }[];
};
