import { contentHash } from "./hash.ts";

export type NormalisedFailure = { class: "assertion" | "timeout" | "infra"; text: string };

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const timeout =
	/\b(?:timeout(?:error|exception)|timed?\s*out|deadline[ -]?exceeded|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|time limit exceeded)\b|(?:^|[\s:])timeout(?:[:.]|\s+(?:of|exceeded|after|waiting|while|reached|occurred|expired)\b|\s+\d|$)/i;
const infrastructureCodes =
	/\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ENOMEM|ENOSPC|EPIPE|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED)|ERR_NAME_NOT_RESOLVED|UnknownHostException|TargetClosedError|OOMKilled|SIGKILL|SIGSEGV|SIGABRT)\b/i;
const infrastructureText =
	/\b(?:connection (?:refused|reset|aborted)|broken pipe|socket hang up|DNS (?:(?:resolution|lookup|query) )?(?:failure|failed|error)|name or service not known|temporary failure in name resolution|no such host|out[ -]of[ -]memory|heap out of memory|Java heap space|cannot allocate memory|disk full|no space left on device|killed)\b|\b(?:browser|runner|worker|renderer|page|context|target|session)(?:\s+(?:process|connection))?(?:\s+(?:has|have|was|is|been|already|unexpectedly))*\s+(?:crashed|closed|disconnected|terminated(?: unexpectedly)?)\b|exit (?:code|status) 137\b/i;
const dependencyStatus =
	/(?:HTTP(?:Error)?(?:\/\d[\d.]*)?(?: error| status(?: code)?)?[: ]+|(?:response(?: code)?|status(?: code)?|server returned)\s*[:=]?\s*)(?:502|503|504)\b|\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/i;
const sourceLocation = /([^\s()"']+\.(?:[cm]?[jt]sx?|py|java|kt|go|rb|rs|cs|cpp|c|h)):\d+(?::\d+)?/g;
const internalFrame =
	/(?:^|[/\\])node_modules(?:[/\\]|$)|(?:^|[/\\])(?:playwright-core|@playwright|vitest|jest)[/\\](?:lib|dist|build|src)[/\\]|(?:^|[/\\])_pytest[/\\]|[/\\]unittest[/\\](?:case|runner|suite|loader|main|mock)\.py|[/\\]src[/\\]testing[/\\]testing\.go|node:internal|bun:test|(?:^|\s)(?:org\.junit\.|org\.testng\.|org\.opentest4j\.|junit\.|java\.lang\.reflect\.|jdk\.internal\.|testing\.tRunner|runtime\.goexit)|<internal>|<frozen /i;

function classify(message: string): NormalisedFailure["class"] {
	if (/\b(?:AssertionError|AssertionFailedError|ComparisonFailure)\b|^(?:E\s+)?assert\b/i.test(message))
		return "assertion";
	const claim = /\bexpected\b|(?:^|\s)(?:Error:\s*)?expect\(/i.test(message);
	if (!claim && dependencyStatus.test(message)) return "infra";
	if (timeout.test(message)) return "timeout";
	if (claim) return "assertion";
	if (infrastructureCodes.test(message) || infrastructureText.test(message)) return "infra";
	return "assertion";
}

function stableText({ text, ids }: { text: string; ids: boolean }): string {
	const stable = text
		.replace(ansi, "")
		.replace(sourceLocation, "$1")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<time>")
		.replace(/\b[0-2]\d:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
		.replace(/(\b(?:timestamp|ts)\s*[:=]\s*)\d{10,13}\b/gi, "$1<time>")
		.replace(/\b\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|µs|us|ns)\b/gi, "<duration>")
		.replace(/\b(?:\d+(?:\.\d+)?h)?(?:\d+(?:\.\d+)?m)?\d+(?:\.\d+)?s\b/gi, "<duration>")
		.replace(/\b0x[0-9a-f]{4,}\b/gi, "<address>")
		.replace(
			/(?:[a-z]:\\(?:[^\s"'<>]*\\)?(?:temp|tmp)\\|\/(?:private\/)?(?:tmp|var\/tmp|var\/folders)\/)[^\s"'<>)]*/gi,
			"<temp>",
		)
		.replace(
			/((?:\b[a-z][a-z0-9+.-]*:\/\/)?(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+|\[[0-9a-f:]+\])):\d{1,5}\b/gi,
			"$1:<port>",
		)
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[a-z0-9_-]+):\d{1,5}\b/gi, "$1:<port>")
		.replace(
			/(\b(?:host|connect(?:ing)?(?: to)?(?: [A-Z_]+)?|at|dial tcp)\s+)([a-z][a-z0-9_-]*):\d{1,5}\b/gi,
			"$1$2:<port>",
		);
	if (!ids) return stable.replace(/\s+/g, " ").trim();
	return stable
		.replace(/\b(?!\d+\b)[0-9a-f]{16,}\b/gi, "<id>")
		.replace(
			/(^|[\s"'=:([{])([A-Za-z0-9+/_-]{24,}={0,2})(?=$|[\s"'.,;:)\]}])/g,
			(whole: string, prefix: string, token: string, offset: number, original: string) => {
				const filename = /^\.(?:[cm]?[jt]sx?|py|java|go|kt|test|spec)\b/i.test(original.slice(offset + whole.length));
				const identifier =
					/[A-Za-z]/.test(token) &&
					/[0-9+/=]/.test(token) &&
					(/[+=]/.test(token) || (/[A-Z]/.test(token) && /[a-z]/.test(token)));
				return identifier && !filename && !token.startsWith("/") && !/^(?:test|toHave|expect|assert)/i.test(token)
					? `${prefix}<id>`
					: whole;
			},
		)
		.replace(/\s+/g, " ")
		.trim();
}

function firstFrame(detail: string): string | null {
	for (const raw of detail.split(/\r?\n/)) {
		const line = raw.replace(ansi, "").trim();
		if (line === "" || internalFrame.test(line)) continue;
		if (/^at\s+/.test(line) || /^File ["']/.test(line) || /\.(?:py|go|java|kt|[cm]?[jt]sx?):\d+/.test(line)) {
			return line.replace(/,?\s*line \d+\b/i, "").replace(/\s+\+0x[0-9a-f]+\s*$/i, "");
		}
	}
	return null;
}

/** Extracts a stable cause line and optional external frame, preserving assertion numbers while replacing volatile syntax. */
export function normaliseFailure(input: { message: string; detail?: string }): NormalisedFailure {
	const message = input.message.replace(ansi, "");
	const meaningful =
		message
			.split(/\r?\n/)
			.find(
				(line) =>
					line.trim() !== "" && !/^(?:Error|Traceback \(most recent call last\)|FAIL|FAILED):?\s*$/i.test(line.trim()),
			) ?? "";
	const frame = input.detail === undefined ? null : firstFrame(input.detail);
	const stable = stableText({ text: meaningful, ids: true });
	if (frame === null) return { class: classify(meaningful), text: stable.slice(0, 300).trimEnd() };
	const frameText = stableText({ text: frame, ids: false });
	const shortenedFrame = frameText.length <= 150 ? frameText : `...${frameText.slice(-147)}`;
	const cause = stable.slice(0, 300 - shortenedFrame.length - 3).trimEnd();
	return { class: classify(meaningful), text: cause === "" ? shortenedFrame : `${cause} | ${shortenedFrame}` };
}

/** Hashes the normalized class and stable cause text with the canonical evidence hash. */
export function signatureHash(normalised: NormalisedFailure): string {
	return contentHash({ class: normalised.class, text: normalised.text });
}
