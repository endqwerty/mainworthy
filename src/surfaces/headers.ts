// The headers every reply of the server carries, whichever route wrote the reply. This file is the policy and
// nothing else: what is known of the request goes in and the headers come out, so it can be read, and tested,
// without a server. `with-headers.ts` puts them on the replies.

/**
 * What a reply is to the browser that receives it.
 *
 * - `page`: the web UI's document from the built bundle, the one the executable and a production start serve.
 * - `development-page`: the same document from Bun's development bundle, which needs more. `inlineScripts` are
 *   the SHA-256 hashes, in base64, of the scripts Bun wrote into that very document.
 * - `other`: everything else. The API's JSON, the change stream, an archive, a script, a style sheet, an error.
 * - `own`: a reply of a route that wrote its own policy, which is kept. The documentation site does: its pages
 *   load its own script and style sheet and frame its own diagrams, and a diagram is a sandboxed page with its
 *   script inside it. No policy of this file fits both, and the site knows which of its replies is which.
 */
export type Content =
	| { readonly kind: "page" }
	| { readonly kind: "development-page"; readonly inlineScripts: readonly string[] }
	| { readonly kind: "other" }
	| { readonly kind: "own"; readonly policy: string };

/** The two things about a request that decide a header. */
export type RequestFacts = {
	/** The request's own URL, as the listener saw it. */
	url: string;
	/** The `X-Forwarded-Proto` header as it arrived, or null when there is none. */
	forwardedProto: string | null;
};

type Policy = Readonly<Record<string, string>>;

/**
 * What the app's document may do. It starts from nothing and names each thing the bundle was seen to need in a
 * browser (`test/e2e/headers.test.ts` runs the app under it, and every other browser test fails on a refusal,
 * because the browser logs one as an error).
 */
const PAGE: Policy = {
	// Whatever is not named below is refused: frames, objects, media, workers, fonts, a manifest.
	"default-src": "'none'",
	// The bundle is one script file from this origin. No inline script and no `eval`: the one library that
	// tried to build a function from a string (zod, to compile its parsers) is told not to in
	// `src/web/lib/no-eval.ts`.
	"script-src": "'self'",
	// One style sheet from this origin. React writes an element's styles through the style object, which a
	// policy does not refuse; nothing in the app writes a `style` attribute or a `<style>` element.
	"style-src": "'self'",
	// The icon. The bundle has no image in a `data:` address and loads none from elsewhere.
	"img-src": "'self'",
	// The API and the change stream. This is what stops a script, should one ever run in the page, from sending
	// what it reads to another host.
	"connect-src": "'self'",
	// No `<base>` element may re-point the page's relative addresses.
	"base-uri": "'none'",
	// The sign-in form is handled by script; if it ever were submitted, it could only go to this origin.
	"form-action": "'self'",
	// No page, on this origin or another, may show the app in a frame and steer its keys and clicks.
	"frame-ancestors": "'none'",
};

/** Base64 of 32 bytes and nothing else: a hash is written into the header, where a quote would be policy. */
const isHash = (text: string): boolean => /^[A-Za-z0-9+/]{43}=$/.test(text);

/**
 * The development bundle is Bun's, not ours. It is served by a start from source without `NODE_ENV=production`
 * (`bun run dev`, and `bun run start` as it is written today), never by the executable. Run in Chromium on Bun
 * 1.4.3 under `PAGE`, it was refused three things, and its policy differs from `PAGE` in those three and no more:
 *
 * - Bun writes one short inline script into the document: in the app's page it tells the development server
 *   when a tab is hidden, and in the page Bun shows for a module that does not build it draws the error. Each
 *   is allowed by its hash, taken from the document it is in. No other inline script is: scripts get no
 *   `'unsafe-inline'`.
 * - A module that changed on disk reaches the open page over the reload socket and is run from a `blob:`
 *   address. Without `blob:` every change is a refused script and then a full reload. What would remove it: Bun
 *   serving a changed module as a file from this origin.
 * - `'unsafe-inline'` for styles: the error Bun shows in the page, for a module that does not build, lays itself
 *   out with a `<style>` element and with `style` attributes it writes as it goes, and a hash cannot allow an
 *   attribute. Without it the error is drawn unstyled over the app. What would remove it: Bun styling that
 *   error from a style sheet, or doing without the error in the page (the terminal shows it too).
 *
 * The reload socket itself is the same host and port, which `'self'` covers, and a changed style sheet is
 * applied through the style sheet object, which a policy does not refuse. There is no `'unsafe-eval'`.
 */
const developmentPage = (inlineScripts: readonly string[]): Policy => ({
	...PAGE,
	"script-src": ["'self'", "blob:", ...inlineScripts.filter(isHash).map((hash) => `'sha256-${hash}'`)].join(" "),
	"style-src": "'self' 'unsafe-inline'",
});

/**
 * A reply that is not the app's document is never meant to be shown as one. If a browser is brought to show it
 * anyway (an address opened in a tab, a reply sniffed as HTML by an old browser), it may load and run nothing.
 */
const OTHER: Policy = {
	"default-src": "'none'",
	"base-uri": "'none'",
	"form-action": "'none'",
	"frame-ancestors": "'none'",
};

function policyFor(content: Exclude<Content, { kind: "own" }>): Policy {
	switch (content.kind) {
		case "page":
			return PAGE;
		case "development-page":
			return developmentPage(content.inlineScripts);
		case "other":
			return OTHER;
		default: {
			const _exhaustive: never = content;
			return _exhaustive;
		}
	}
}

/** The `Content-Security-Policy` header for a reply of this kind. */
export const contentSecurityPolicy = (content: Content): string =>
	content.kind === "own"
		? content.policy
		: Object.entries(policyFor(content))
				.map(([directive, sources]) => `${directive} ${sources}`)
				.join("; ");

/**
 * `X-Frame-Options` for a reply: what its policy's `frame-ancestors` says, for the browsers that only know this
 * header. A policy that lets this server's own pages frame the reply (`frame-ancestors 'self'`, the
 * documentation's pages and diagrams) is `SAMEORIGIN`; every other reply is `DENY`.
 */
const frameOptions = (content: Content): string =>
	content.kind === "own" && /(?:^|;)\s*frame-ancestors\s+'self'\s*(?:;|$)/.test(content.policy) ? "SAMEORIGIN" : "DENY";

/**
 * Whether the request reached the first server it met over https: by its own scheme, or by what the proxy in
 * front reports. A chain of proxies writes a list (`https, http`), the first element being the hop the browser
 * made; the name is compared in lower case because nothing obliges a proxy to write it that way.
 */
export function arrivedOverHttps(request: RequestFacts): boolean {
	return forwardedScheme(request.forwardedProto) === "https" || /^https:/i.test(request.url);
}

/**
 * The scheme a proxy reports in `X-Forwarded-Proto`, or null when the header is absent or empty. The one place
 * the header is read: the Origin check, the cookie's `Secure` and `Strict-Transport-Security` cannot disagree
 * about how the browser arrived.
 */
export function forwardedScheme(header: string | null): string | null {
	return header?.split(",")[0]?.trim().toLowerCase() || null;
}

/**
 * Whether a browser treats the origin the request was sent to as trustworthy: reached over https, or a name of
 * this machine (`localhost` and its subdomains, 127.0.0.0/8, `[::1]`), which a browser trusts over plain http.
 */
export function trustworthyOrigin(request: RequestFacts): boolean {
	if (arrivedOverHttps(request)) return true;
	let host: string;
	try {
		host = new URL(request.url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Every header the policy adds to a reply, by lower-case name. */
export function securityHeaders(request: RequestFacts, content: Content): Record<string, string> {
	return {
		"content-security-policy": contentSecurityPolicy(content),
		// The declared content type is the type: a JSON reply or an uploaded text is never guessed to be a script.
		"x-content-type-options": "nosniff",
		// An address of the app names a project and a case. No other site is told which one a link was followed from.
		"referrer-policy": "no-referrer",
		// The same rule as the policy's `frame-ancestors`, for the browsers that only know this header.
		"x-frame-options": frameOptions(content),
		// A window this page opens, or was opened from, on another origin gets no handle on this one. A browser
		// honours this only on an origin it trusts (https, or this machine) and logs an error for it anywhere
		// else, so plain http on a network name goes without, as it does without `Strict-Transport-Security`.
		...(trustworthyOrigin(request) ? { "cross-origin-opener-policy": "same-origin" } : {}),
		// No other origin may embed a reply as an image, a script or a style sheet and learn from how it loads.
		"cross-origin-resource-policy": "same-origin",
		// A year of https only, for this host alone: the name's other hosts are not this server's to promise for,
		// so there is no `includeSubDomains` and no `preload`. A browser ignores the header on plain http, and a
		// laptop's `http://127.0.0.1` must keep working, so it is sent only when the request came over https.
		...(arrivedOverHttps(request) ? { "strict-transport-security": "max-age=31536000" } : {}),
	};
}
