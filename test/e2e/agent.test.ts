import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../../src/web/lib/api.ts";
import { browserAvailable, eventually, openPage, type Server } from "./support.ts";

/** Builder 2 has its own port range while Builder 1 uses the shared fixture. */
async function fixture({
	preset = "standard",
	mode = "local",
}: {
	preset?: string;
	mode?: "local" | "server";
} = {}): Promise<Server> {
	const directory = await mkdtemp(join(tmpdir(), "casebook-builder2-"));
	let port = 7471;
	for (; port <= 7499; port++) {
		try {
			const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
			await probe.stop(true);
			break;
		} catch {}
	}
	if (port > 7499) {
		await rm(directory, { recursive: true, force: true });
		throw new Error("No free Builder 2 port");
	}
	const token = crypto.randomUUID();
	const url = `http://127.0.0.1:${port}`;
	const child = Bun.spawn([process.execPath, "test/e2e/serve.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			CASEBOOK_PORT: String(port),
			CASEBOOK_DATA: directory,
			CASEBOOK_MODE: mode,
			CASEBOOK_OWNER_TOKEN: token,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const stop = async () => {
		child.kill("SIGTERM");
		await child.exited;
		await rm(directory, { recursive: true, force: true });
	};
	const api: Server["api"] = (op, input, options = {}) =>
		call(op, input, { url, project: "scratch", token: options.token ?? token });
	try {
		await eventually(async () => {
			if (child.exitCode !== null) throw new Error("Builder 2 server exited before readiness");
			try {
				return (await fetch(`${url}/healthz`)).ok;
			} catch {
				return false;
			}
		}, Boolean);
		if (preset !== "loose") {
			const proposed = await api("propose", { edits: [{ op: "policy", preset }] });
			const q = (await api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
			if (!q) throw new Error("Preset proposal question is missing");
			const replies = await api("decide", {
				q: q.q,
				onEvidence: q.evidenceHash,
				answer: { is: "accept" },
				reason: "Configure the browser test preset",
			});
			if (replies[0]?.status !== "decided") throw new Error("Preset was not applied");
		}
		return { url, project: "scratch", token, api, seeded: null, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

import { z } from "zod";

(browserAvailable ? test : test.skip)(
	"standard: a adopts the agent's real diff and preserves agent attribution",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total updates" }],
			});
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const body = (await server.api("get", { refs: ["C-1"] }))[0];
			const steps = z
				.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() }))
				.parse(body?.steps);
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: { steps: steps.map((step) => ({ ...step, expected: "Total shows $90.00" })) },
						},
					],
					reason: "Give the coupon an exact assertion",
				},
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			view = await openPage(server, { path: `/p/scratch/queue/${proposed.question?.slice(2)}` });
			await view.page.locator(".prop .diff").waitFor();
			expect(await view.page.locator(".prop .diff").innerText()).toContain("$90.00");
			expect(await view.page.locator(".prop").innerText()).toContain("writer proposes");
			await view.page.keyboard.press("a");
			const current = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(z.array(z.object({ expected: z.string().nullable() })).parse(current[0]?.steps)[0]?.expected).toBe(
				"Total shows $90.00",
			);
			const timeline = await server.api("timeline", { ref: "C-1" });
			expect(timeline.entries.find((entry) => entry.t === "version" && entry.version === 2)).toMatchObject({
				by: "writer",
				kind: "agent",
			});
			await view.page.keyboard.press("u");
			await view.page.getByText("Adopted versions cannot be withdrawn.", { exact: false }).waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(view.errors).toEqual([]);
			expect(view.dialogs).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);
