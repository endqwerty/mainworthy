// The web UI's files, each sent with the headers of `headers.ts`.
//
// The UI reaches the server as an HTML import (`import ui from "../web/index.html"`). Handed to `Bun.serve` as a
// route, Bun serves the page and its files itself and offers no way to add a header to them (Bun 1.4.3). So the
// route is ours, and there are two of it, for the two things an HTML import can be:
//
// - In the executable (`bun run build`) the import is a list of the files built into it. They are served from
//   here: nothing else listens and nothing is bundled at run time.
// - Started from source, the import names the HTML file and Bun bundles on request, with its reload socket in
//   development. Bun keeps doing that, on a socket file only this process knows, and each reply is passed on
//   with the headers. The reload socket is relayed, for a visitor Bun itself would have let in and no other.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { withHeaders } from "./with-headers.ts";

/** What one browser's reload socket is relayed to, and what the bundler said on it before the browser's was open. */
type Relay = { upstream: WebSocket; early: (string | ArrayBuffer)[] };

/** Whether a request comes from this server's own page: the HTTP surface's rule for a browser's requests. */
type FromThisServer = (req: Request) => boolean;

export type UiSurface = {
	/** The route for every path no other route takes. It answers nothing when it has made the request a socket. */
	route: (req: Request, server: Bun.Server<Relay>) => Response | undefined | Promise<Response | undefined>;
	/** The reload socket's relay; only a start from source has one. */
	websocket?: Bun.WebSocketHandler<Relay>;
};

/** The files a build put into the executable, as Bun lists them on the HTML import. */
const Built = z.object({
	index: z.string(),
	files: z
		.array(z.object({ path: z.string(), headers: z.object({ etag: z.string(), "content-type": z.string() }) }))
		.min(1),
});
type Built = z.infer<typeof Built>;

/** An HTML import Bun has yet to bundle: it names the HTML file and nothing more. */
const isHtmlImport = (ui: unknown): ui is Bun.HTMLBundle =>
	typeof ui === "object" && ui !== null && "index" in ui && typeof ui.index === "string";

const notAllowed = (req: Request): Response =>
	withHeaders(req, new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }));

/**
 * The route that serves the web UI, from whichever of the two an HTML import is. `fromThisServer` decides who may
 * open the development reload socket; the built bundle has none.
 */
export function uiSurface(ui: unknown, fromThisServer: FromThisServer): UiSurface {
	const built = Built.safeParse(ui);
	if (built.success) return { route: builtRoute(built.data) };
	if (isHtmlImport(ui)) return bundledByBun(ui, fromThisServer);
	throw new Error("the web UI is neither a built bundle nor an HTML import");
}

/**
 * A file whose name carries a hash of its content (`chunk-xe7fvs3b.js`) never changes under that name, so a
 * browser may keep it for good. The page names those files and is asked for again on every visit, as is any
 * file whose name carries no hash.
 */
const KEEP = "public, max-age=31536000, immutable";
const ASK_AGAIN = "no-cache";
const namedByContent = (path: string): boolean => /-[a-z0-9]{8}\.[a-z0-9]+$/.test(path);

/**
 * Whether the browser already holds this version: its `If-None-Match` names the tag, weak or strong, or is `*`,
 * which is "any version of it".
 */
const holds = (req: Request, etag: string): boolean =>
	(req.headers.get("if-none-match") ?? "")
		.split(",")
		.map((held) => held.trim())
		.some((held) => held === "*" || held.replace(/^W\//, "") === etag);

function builtRoute(bundle: Built): UiSurface["route"] {
	const root = dirname(bundle.index);
	const files = new Map(bundle.files.map((file) => [`/${relative(root, file.path).replaceAll("\\", "/")}`, file]));
	const page = bundle.files.find((file) => file.path === bundle.index);
	if (!page) throw new Error("the built web UI does not list its own page");
	return (req) => {
		if (req.method !== "GET" && req.method !== "HEAD") return notAllowed(req);
		// The app routes in the browser: every address that is not one of its files is the page.
		const file = files.get(new URL(req.url).pathname) ?? page;
		const etag = `"${file.headers.etag.replaceAll('"', "")}"`;
		const headers = {
			"content-type": file.headers["content-type"],
			etag,
			"cache-control": file !== page && namedByContent(file.path) ? KEEP : ASK_AGAIN,
		};
		const reply = holds(req, etag)
			? new Response(null, { status: 304, headers })
			: new Response(Bun.file(file.path), { headers });
		return withHeaders(req, reply, { kind: file === page ? "page" : "other" });
	};
}

/** Bun's bundler for one HTML import, listening where only this process finds it. */
type Bundler = { socket: string; development: boolean };
const bundlers = new WeakMap<Bun.HTMLBundle, Bundler>();

/** The socket's directory is named for the process that made it, so that a later one can tell it is abandoned. */
const SOCKET_DIRECTORY = /^mainworthy-ui-(\d+)-/;
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// A process this user may not signal is somebody's and is running.
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
};
/**
 * Removes, once, the socket directories nobody uses any more. A process removes its own when it ends, but one
 * that is killed cannot, and neither can a test process (`bun test` runs no exit handler) or a restart under
 * `bun --watch`, which starts the program again in the same process: without this each of them would leave a
 * directory behind for good. Abandoned means: its process is gone, or it is this process, which has made none yet.
 */
let abandonedRemoved = false;
function removeAbandoned(): void {
	if (abandonedRemoved) return;
	abandonedRemoved = true;
	try {
		for (const name of readdirSync(tmpdir())) {
			const pid = Number(SOCKET_DIRECTORY.exec(name)?.[1]);
			if (Number.isInteger(pid) && (pid === process.pid || !alive(pid)))
				rmSync(join(tmpdir(), name), { recursive: true, force: true });
		}
	} catch {
		// Somebody else's directory, or a temporary directory that cannot be listed: nothing of ours to remove.
	}
}

/**
 * One listener for an HTML import, for as long as the process lives: the import is one object however many
 * servers the process starts (the tests start many). It does not keep the process alive, and its socket file,
 * in a directory only this user can open, is removed when the process ends.
 */
function bundlerOf(ui: Bun.HTMLBundle): Bundler {
	const known = bundlers.get(ui);
	if (known) return known;
	removeAbandoned();
	const directory = mkdtempSync(join(tmpdir(), `mainworthy-ui-${process.pid}-`));
	process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
	const socket = join(directory, "ui.sock");
	const server = Bun.serve({
		unix: socket,
		routes: { "/*": ui },
		fetch: () => new Response(null, { status: 404 }),
	});
	server.unref();
	const bundler = { socket, development: server.development };
	bundlers.set(ui, bundler);
	return bundler;
}

/**
 * What is passed on to the bundler in the browser's name. `Host`, because the development server refuses a name
 * it does not expect and must judge the one the browser sent. `Content-Type`, for what the development page
 * posts. `If-None-Match`, so that the bundler can answer "you already have this"; the development server never
 * does, and its page must arrive whole to be read below, so there it is left out.
 */
const PASSED_ON = ["host", "content-type", "if-none-match"];
/** What describes one connection and not the reply; the listener writes its own. */
const PER_CONNECTION = ["connection", "keep-alive", "transfer-encoding", "date"];

/** The hash a policy names an inline script by, for each script written into the document itself. */
const inlineScriptHashes = (html: string): string[] =>
	[...html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((script) =>
		new Bun.CryptoHasher("sha256").update(script[1] ?? "").digest("base64"),
	);

/** The path Bun's development page opens its reload socket on (`"/_bun/hmr"` in the script Bun serves with it). */
const RELOAD_SOCKET = "/_bun/hmr";

/**
 * Bun's WebSocket client takes headers to send with its handshake (`Bun.WebSocketOptions`). The type this
 * project loads for `WebSocket` is the DOM's, for the web UI, and describes a browser's, which takes none. The
 * cast says which of the two this process runs; `test/headers.test.ts` fails if the headers are not sent.
 */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

/**
 * Asks the bundler to accept a reload socket for this visitor, and answers with the socket if it did. The
 * bundler is shown the `Host` and the `Origin` the visitor sent, so that its own rule (a name of this machine or
 * an address, and an Origin that is one too) judges the visitor and not this process, which it would always let
 * in. What it says before the visitor's own socket is open is kept.
 */
function acceptedByBundler(socket: string, path: string, req: Request): Promise<Relay | null> {
	const headers: Record<string, string> = {};
	for (const name of ["host", "origin"]) {
		const value = req.headers.get(name);
		if (value !== null) headers[name] = value;
	}
	return new Promise((resolve) => {
		const upstream = new BunWebSocket(`ws+unix://${socket}:${path}`, { headers });
		const early: Relay["early"] = [];
		upstream.binaryType = "arraybuffer";
		upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
			early.push(event.data);
		};
		upstream.onopen = () => resolve({ upstream, early });
		upstream.onerror = () => resolve(null);
		upstream.onclose = () => resolve(null);
	});
}

function bundledByBun(ui: Bun.HTMLBundle, fromThisServer: FromThisServer): UiSurface {
	const { socket, development } = bundlerOf(ui);
	/**
	 * The development reload socket, for this server's own page only. Before anything is opened the visitor
	 * passes two checks, and one who fails either is answered 403: the HTTP surface's own rule for a browser's
	 * request (the Origin, where one is sent, is this server, scheme and host), and then the bundler's, on the
	 * visitor's own headers. Bun's route, which this one replaced, refused a page on another site and a name that
	 * is not this machine's; without the checks this process would have vouched for both.
	 */
	const reloadSocket = async (req: Request, server: Bun.Server<Relay>, path: string): Promise<Response | undefined> => {
		const refused = (): Response =>
			withHeaders(req, new Response("the reload socket is for this server's own page\n", { status: 403 }));
		if (!fromThisServer(req)) return refused();
		const relay = await acceptedByBundler(socket, path, req);
		if (!relay) return refused();
		if (server.upgrade(req, { data: relay })) return undefined;
		relay.upstream.close();
		return withHeaders(req, new Response(null, { status: 400 }));
	};
	const route: UiSurface["route"] = async (req, server) => {
		const url = new URL(req.url);
		const path = `${url.pathname}${url.search}`;
		// Only the one path is ever made a socket. An upgrade asked of any other is answered as a plain request
		// for that path, which is what Bun's own route did.
		if (development && url.pathname === RELOAD_SOCKET && req.headers.get("upgrade")?.toLowerCase() === "websocket")
			return reloadSocket(req, server, path);
		const reads = req.method === "GET" || req.method === "HEAD";
		// The built bundle is files to read. The development bundle also takes what its own script in the page
		// posts to it (a tab that was hidden, an error to show in the terminal), so there every method is passed on.
		if (!reads && !development) return notAllowed(req);
		const headers = new Headers();
		for (const name of PASSED_ON) {
			const value = req.headers.get(name);
			if (value !== null && !(development && name === "if-none-match")) headers.set(name, value);
		}
		const bundled = await fetch(`http://localhost${path}`, {
			unix: socket,
			method: req.method,
			headers,
			// Passed on as it arrives, so nothing of it is held here and the bundler applies its own limit.
			body: reads ? null : req.body,
			redirect: "manual",
			decompress: false,
		});
		const passed = new Headers(bundled.headers);
		for (const name of PER_CONNECTION) passed.delete(name);
		const reply = (body: BodyInit | null) => new Response(body, { status: bundled.status, headers: passed });
		if (!(passed.get("content-type") ?? "").startsWith("text/html"))
			return withHeaders(req, reply(bundled.body), { kind: "other" });
		if (!development) return withHeaders(req, reply(bundled.body), { kind: "page" });
		// The development page carries a script of Bun's in its text. The policy allows exactly the scripts that
		// are in this document, which is built from `src/web/index.html` and holds nothing a user wrote.
		const html = await bundled.text();
		passed.delete("content-length");
		return withHeaders(req, reply(req.method === "HEAD" ? null : html), {
			kind: "development-page",
			inlineScripts: inlineScriptHashes(html),
		});
	};
	if (!development) return { route };
	return {
		route,
		// The development bundle reloads the page over a socket to the server. The browser's socket ends here and
		// each message is passed on, in both directions, to the one the bundler accepted for it. The reply that
		// opens it (101) carries none of the headers: a browser applies none of them to a socket.
		websocket: {
			open(ws) {
				const { upstream, early } = ws.data;
				for (const message of early.splice(0)) ws.send(message);
				upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
					ws.send(event.data);
				};
				upstream.onclose = () => ws.close();
				if (upstream.readyState !== WebSocket.OPEN) ws.close();
			},
			message(ws, received) {
				ws.data.upstream.send(typeof received === "string" ? received : new Uint8Array(received));
			},
			close(ws) {
				ws.data.upstream.close();
			},
		},
	};
}
