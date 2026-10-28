// A person signs in as themselves, in a browser: Chromium accepts an invitation through the identity provider,
// signs out, signs in again through it, lists its session and ends it. The page is the server's own origin and
// nothing of the web UI is used: every step is a `fetch` the page makes or a navigation to the provider and back,
// so the cookies, the origin and the redirects are the browser's own. `test/oidc.test.ts` holds the protocol's
// rules; this file is the proof that a real browser gets through them.
import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { API_VERSION, API_VERSION_HEADER } from "../../src/core/version.ts";
import { browserAvailable, openPage, type PageHarness, type Server, startServer, subjectOf } from "./support.ts";

type Reply = { status: number; body: { ok: boolean; result?: unknown; error?: { code: string; message: string } } };

/** `fetch` in the page, to its own origin: the browser attaches the cookie and says where the request is from. */
const send = (page: Page, path: string, body?: unknown): Promise<Reply> =>
	page.evaluate(
		async ([path, json, versionHeader, version]) => {
			const response = await fetch(path, {
				method: json === null ? "GET" : "POST",
				headers: { "content-type": "application/json", [versionHeader]: String(version) },
				...(json === null ? {} : { body: json }),
			});
			return { status: response.status, body: await response.json() };
		},
		[path, body === undefined ? null : JSON.stringify(body), API_VERSION_HEADER, API_VERSION] as const,
	);

const resultOf = <T = unknown>(reply: Reply): T => {
	if (!reply.body.ok) throw new Error(`refused: ${reply.status} ${JSON.stringify(reply.body)}`);
	return reply.body.result as T;
};

/**
 * Goes to the provider at `url` as a browser does, signed in there as `subject`, and comes back to the page the
 * provider sends it to. Its scripts are answered with empty modules so the web UI does not finish the
 * ceremony itself: the query it was sent back with, which the test hands the server.
 */
async function roundTrip(page: Page, server: Server, url: string, subject: string): Promise<string> {
	server.idp?.next({ subject, email: `${subject}@example.com` });
	const back = (address: URL) => address.origin === server.url && address.pathname === "/signin/oidc";
	// Playwright routes only the first URL of a redirect chain, so the callback document cannot be intercepted.
	const scripts = (address: URL) => address.origin === server.url && address.pathname.endsWith(".js");
	await page.route(scripts, (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
	try {
		await page.goto(url);
		await page.waitForURL(back);
		const query = new URL(page.url()).search;
		if (!query) throw new Error(`the provider did not send the browser back here: ${page.url()}`);
		return query;
	} finally {
		await page.unroute(scripts);
	}
}

test.skipIf(!browserAvailable)(
	"a person accepts an invitation through the provider, signs out, signs in through it, lists the session and ends it",
	async () => {
		const server = await startServer({ mode: "server", provider: true });
		let browser: PageHarness | null = null;
		try {
			const invited = await fetch(`${server.url}/api/invitation`, {
				method: "POST",
				headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
				body: JSON.stringify({ do: "create", name: "sam", can: ["read"], project: "scratch" }),
			});
			const { code, link } = ((await invited.json()) as { result: { code: string; link: string } }).result;
			expect(link).toBe(`${server.url}/invite#${code}`);

			browser = await openPage(server, { signedIn: false });
			const { page } = browser;
			// The sign-in page is told what this instance offers, and nobody is signed in.
			expect(resultOf<unknown>(await send(page, "/api/login/methods"))).toEqual({
				token: true,
				oidc: { name: "Example ID" },
			});
			expect((await send(page, "/api/session")).status).toBe(401);

			// The invitation: who it is for. Looking does not spend it.
			const shown = resultOf<{ invitation: { name: string; purpose: string } }>(
				await send(page, "/api/login/invitation", { invitation: code }),
			);
			expect(shown.invitation).toMatchObject({ name: "sam", purpose: "join" });
			// Beginning hands the browser a ceremony cookie it cannot read, and the provider's address.
			const ceremony = async () =>
				(await browser?.context.cookies())?.filter((cookie) => cookie.name === "mainworthy_ceremony") ?? [];
			const begun = resultOf<{ url: string }>(await send(page, "/api/login/oidc", { invitation: code }));
			expect(await ceremony()).toMatchObject([{ httpOnly: true, sameSite: "Strict", path: "/" }]);
			expect(await page.evaluate(() => document.cookie)).not.toContain("mainworthy_ceremony");
			const back = await roundTrip(page, server, begun.url, subjectOf("sam"));
			const accepted = await send(page, "/api/login", { oidc: back });
			expect(accepted.status).toBe(200);
			expect(accepted.body).toEqual({ ok: true, result: { signedIn: true } });
			// The answer's reply takes the ceremony cookie away again.
			expect(await ceremony()).toEqual([]);
			// The session cookie is the browser's: the page cannot read it, and the next request carries it.
			expect(await page.evaluate(() => document.cookie)).not.toContain("mainworthy_sid");
			const first = resultOf<{ actor: string; via: string; session: number; credentials: unknown }>(
				await send(page, "/api/session"),
			);
			expect(first).toMatchObject({ actor: "sam", via: "cookie", credentials: { identities: 1 } });
			expect(resultOf(await send(page, "/api/credential", { do: "list" }))).toMatchObject([
				{ kind: "oidc", label: "Example ID (sub-sam@example.com)" },
			]);
			// The invitation is spent.
			expect((await send(page, "/api/login/invitation", { invitation: code })).status).toBe(404);
			// The same answer signs nobody in a second time.
			expect((await send(page, "/api/login", { oidc: back })).status).toBe(401);

			// Sign out, and in again through the provider: the provider says who it is, and nothing is typed here.
			expect((await send(page, "/api/logout", {})).status).toBe(200);
			expect((await send(page, "/api/session")).status).toBe(401);
			const again = resultOf<{ url: string }>(await send(page, "/api/login/oidc", {}));
			const answer = await roundTrip(page, server, again.url, subjectOf("sam"));
			expect((await send(page, "/api/login", { oidc: answer })).status).toBe(200);
			const second = resultOf<{ actor: string; session: number }>(await send(page, "/api/session"));
			expect(second.actor).toBe("sam");
			expect(second.session).not.toBe(first.session);

			// The list holds this one session, opened through the provider, and marks it as the page's own.
			const sessions = resultOf<{ id: number; openedWith: string; current: boolean; userAgent: string }[]>(
				await send(page, "/api/session", { do: "list" }),
			);
			expect(sessions).toMatchObject([{ id: second.session, openedWith: "oidc", current: true }]);
			expect(sessions[0]?.userAgent).toContain("Chrome");
			// Ending it signs the page out.
			expect(resultOf<unknown>(await send(page, "/api/session", { do: "end", id: second.session }))).toEqual({
				ended: true,
				current: true,
			});
			expect((await send(page, "/api/session")).status).toBe(401);
			// The one refusal this journey asked for on purpose and the console shows: the spent invitation.
			expect(browser.errors).toEqual([
				"Failed to load resource: the server responded with a status of 404 (Not Found)",
			]);
		} finally {
			await browser?.close();
			await server.stop();
		}
	},
	30_000,
);
