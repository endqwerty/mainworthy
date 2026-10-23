import { contentHash } from "./hash.ts";
import { clip, clipEnd } from "./text.ts";

export type NormalisedFailure =
	| { class: "assertion" | "timeout" | "infra"; text: string }
	| { class: "unknown"; text: "" };

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const timeout =
	/\b(?:timeout(?:error|exception)|timed?\s*out|deadline[ -]?exceeded|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|time limit exceeded)\b|(?:^|[\s:])timeout(?:[:.]|\s+(?:of|exceeded|after|waiting|while|reached|occurred|expired)\b|\s+\d|$)/i;
const infrastructureCodes =
	/\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ENOMEM|ENOSPC|EPIPE|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED)|ERR_NAME_NOT_RESOLVED|UnknownHostException|TargetClosedError|OOMKilled|SIGKILL|SIGSEGV|SIGABRT)\b/i;
const infrastructureText =
	/\b(?:connection (?:refused|reset|aborted)|broken pipe|socket hang up|DNS (?:(?:resolution|lookup|query) )?(?:failure|failed|error)|name or service not known|temporary failure in name resolution|no such host|out[ -]of[ -]memory|heap out of memory|Java heap space|cannot allocate memory|disk full|no space left on device|killed)\b|\b(?:browser|runner|worker|renderer|page|context|target|session)(?:\s+(?:process|connection))?(?:\s+(?:has|have|was|is|been|already|unexpectedly))*\s+(?:crashed|closed|disconnected|terminated(?: unexpectedly)?)\b|exit (?:code|status) 137\b/i;
const dependencyStatus =
	/(?:HTTP(?:Error)?(?:\/\d[\d.]*)?(?: error| status(?: code)?)?[: ]+|(?:response(?: code)?|status(?: code)?|server returned)\s*[:=]?\s*)(?:502|503|504)\b|\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/i;
const sourceLocation = /(^|[\s("'])([^\s()"'<>]+\.(?:[cm]?[jt]sx?|py|java|kt|go|rb|rs|cs|cpp|c|h)):\d+(?::\d+)?/g;
const internalFrame =
	/(?:^|[/\\])node_modules(?:[/\\]|$)|(?:^|[/\\])(?:playwright-core|@playwright|vitest|jest)[/\\](?:lib|dist|build|src)[/\\]|(?:^|[/\\])_pytest[/\\]|[/\\]unittest[/\\](?:case|runner|suite|loader|main|mock)\.py|[/\\]src[/\\]testing[/\\]testing\.go|node:internal|bun:test|(?:^|\s)(?:org\.junit\.|org\.testng\.|org\.opentest4j\.|junit\.|java\.lang\.reflect\.|jdk\.internal\.|testing\.tRunner|runtime\.goexit)|<internal>|<frozen /i;

function classify(message: string): Exclude<NormalisedFailure["class"], "unknown"> {
	if (/\b(?:AssertionError|AssertionFailedError|ComparisonFailure)\b|^(?:E\s+)?assert\b/i.test(message))
		return "assertion";
	if (/^\s*(?:Error:\s*)?expected\b/i.test(message)) return "assertion";
	const claim = /\bexpected\b|(?:^|\s)(?:Error:\s*)?expect\(/i.test(message);
	if (!claim && dependencyStatus.test(message)) return "infra";
	if (timeout.test(message)) return "timeout";
	if (claim) return "assertion";
	if (infrastructureCodes.test(message) || infrastructureText.test(message)) return "infra";
	return "assertion";
}

function normaliseDurations({ text }: { text: string }): string {
	const replace = (duration: string, offset: number, original: string): string =>
		/\d\s+$/.test(original.slice(Math.max(0, offset - 20), offset)) ? duration : "<duration>";
	return text
		.replace(/\b(?:\d+(?:\.\d+)?h)?(?:\d+(?:\.\d+)?m)?\d+(?:\.\d+)?s\b/g, replace)
		.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|µs|us|ns)\b/g, replace)
		.replace(/\b\d+(?:\.\d+)?\s*(?:milliseconds?|seconds?|secs?|minutes?|mins?)\b/gi, replace);
}

function stableText({ text, ids, preserveNumbers }: { text: string; ids: boolean; preserveNumbers: boolean }): string {
	const stable = text
		.replace(ansi, "")
		.replace(sourceLocation, "$1$2")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<time>")
		.replace(/\b[0-2]\d:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
		.replace(/(\b(?:timestamp|ts)\s*[:=]\s*)\d{10,13}\b/gi, "$1<time>")
		.replace(/\b0x[0-9a-f]{4,}\b/gi, "<address>")
		.replace(
			/(?:[a-z]:\\(?:[^\s"'<>]*\\)?(?:temp|tmp)\\|\/(?:private\/)?(?:tmp|var\/tmp|var\/folders)\/)[^\s"'<>)]*/gi,
			"<temp>",
		)
		.replace(
			/(^|[\s("'<>])((?:[a-z][a-z0-9+.-]*:\/\/)?(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+|\[[0-9a-f:]+\])):\d{1,5}\b/gi,
			"$1$2:<port>",
		)
		.replace(/(^|[\s("'<>])([a-z][a-z0-9+.-]*:\/\/[a-z0-9_-]+):\d{1,5}\b/gi, "$1$2:<port>")
		.replace(
			/(\b(?:host|connect(?:ing)?(?: to)?(?: [A-Z_]+)?|at|dial tcp)\s+)([a-z][a-z0-9_-]*):\d{1,5}\b/gi,
			"$1$2:<port>",
		);
	const timed = preserveNumbers ? stable : normaliseDurations({ text: stable });
	if (!ids) return timed.replace(/\s+/g, " ").trim();
	return timed
		.replace(/\b(?!\d+\b)[0-9a-f]{16,}\b/gi, "<id>")
		.replace(
			/(^|[\s"'=:([{])([A-Za-z0-9+/_-]{24,}={0,2})(?=$|[\s"'.,;:)\]}])/g,
			(whole: string, prefix: string, token: string, offset: number, original: string) => {
				const filename = /^\.(?:[cm]?[jt]sx?|py|java|go|kt|test|spec)\b/i.test(original.slice(offset + whole.length));
				const labelled =
					/\b(?:id|token|nonce|digest|request(?:id)?|session(?:id)?|trace(?:id)?|base64)[\s:= "'-]*$/i.test(
						original.slice(Math.max(0, offset - 40), offset) + prefix,
					);
				const identifier = /[A-Za-z]/.test(token) && (/[+=]/.test(token) || labelled);
				return identifier && !filename && !token.startsWith("/") && !/^(?:test|toHave|expect|assert)/i.test(token)
					? `${prefix}<id>`
					: whole;
			},
		)
		.replace(/\s+/g, " ")
		.trim();
}

/** The longest line any pattern below is run on. Every pattern is at worst quadratic in the line, so this bounds the work. */
const LINE_LIMIT = 512;
/** How much of a stack is searched for the first frame outside the test framework. */
const DETAIL_LINES = 200;

/**
 * One line made safe to match: cut to `LINE_LIMIT` and with runs of spaces and tabs collapsed. Failure text comes
 * from test reports, which are untrusted input; without this a single crafted line (a keyword followed by
 * thousands of spaces) costs hundreds of milliseconds, and a report can carry thousands of them.
 */
function bounded(line: string): string {
	return clip(clip(line, LINE_LIMIT * 4).replace(/[ \t\f\v]{2,}/g, " "), LINE_LIMIT);
}

function firstFrame(detail: string): string | null {
	let seen = 0;
	for (const raw of detail.split(/\r?\n/, DETAIL_LINES)) {
		if (++seen > DETAIL_LINES) break;
		const line = bounded(raw.replace(ansi, "")).trim();
		if (line === "" || internalFrame.test(line)) continue;
		if (/^at\s+/.test(line) || /^File ["']/.test(line) || /\.(?:py|go|java|kt|[cm]?[jt]sx?):\d+/.test(line)) {
			return line.replace(/,? ?line \d+\b/i, "").replace(/ ?\+0x[0-9a-f]+ ?$/i, "");
		}
	}
	return null;
}

function causeLine(text: string): string {
	for (const raw of clip(text, 16_384).replace(ansi, "").split(/\r?\n/, 50)) {
		const line = bounded(raw).trim();
		if (
			line === "" ||
			/^(?:Error|Traceback \(most recent call last\)|FAIL|FAILED):?\s*$/i.test(line) ||
			/^at\s+|^File ["']/i.test(line)
		)
			continue;
		return line;
	}
	return "";
}

/**
 * Extracts a stable cause line and optional external frame, preserving assertion numbers while replacing volatile
 * syntax. Runs in time bounded by constants whatever the input: every line is cut and compacted before any
 * pattern sees it.
 */
export function normaliseFailure(input: { message: string; detail?: string }): NormalisedFailure {
	const detail = clip(input.detail ?? "", 65_536);
	const meaningful = causeLine(input.message) || causeLine(detail);
	if (meaningful === "") return { class: "unknown", text: "" };
	const frame = firstFrame(detail);
	const failureClass = classify(meaningful);
	const preserveNumbers = failureClass === "assertion" && /\b(?:expected|assertion|assert)|expect\(/i.test(meaningful);
	const stable = stableText({ text: meaningful, ids: true, preserveNumbers });
	if (frame === null) return { class: failureClass, text: clip(stable, 300).trimEnd() };
	const frameText = stableText({ text: frame, ids: false, preserveNumbers: true });
	const shortenedFrame = frameText.length <= 150 ? frameText : `...${clipEnd(frameText, 147)}`;
	const cause = clip(stable, 300 - shortenedFrame.length - 3).trimEnd();
	return { class: failureClass, text: cause === "" ? shortenedFrame : `${cause} | ${shortenedFrame}` };
}

/** Hashes the normalized class and stable cause text with the canonical evidence hash. */
export function signatureHash(normalised: Pick<NormalisedFailure, "class" | "text">): string {
	return contentHash({ class: normalised.class, text: normalised.text });
}
