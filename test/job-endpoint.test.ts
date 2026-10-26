import { afterEach, expect, test } from "bun:test";
import { generateKeyPair, SignJWT } from "jose";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { authenticateJob } from "../src/server/kernel/job-auth.ts";
import { enqueueJob, jobById } from "../src/server/kernel/jobs.ts";
import { OPS } from "../src/server/ops/index.ts";
import { jobOp } from "../src/server/ops/jobs.ts";
import { invoke, invokeService } from "../src/server/ops/registry.ts";
import { serve } from "../src/surfaces/http.ts";
import { type Harness, harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => h?.close());
const service = { audience: "https://jobs.example.com", account: "worker@example.iam.gserviceaccount.com" };
test("the public job endpoint refuses unauthenticated requests and ordinary authenticated callers", async () => {
	h = await harness();
	const server = serve(h.app, h.owner, { ui: null });
	try {
		const response = await fetch(`http://127.0.0.1:${server.port}/api/job`, {
			method: "POST",
			body: JSON.stringify({ do: "tick" }),
		});
		expect(response.status).toBe(401);
		expect(
			await invoke(h.app, OPS, { op: "job", project: null, input: { do: "tick" }, actor: async () => h.owner }),
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
	} finally {
		await server.stop(true);
	}
});
test("a server that takes the Scheduler's calls still serves everything else, and /api/job checks the token", async () => {
	h = await harness();
	// The two settings alone, on an ordinary server: no job-only mode.
	const read = defaultConfig({ MAINWORTHY_JOB_AUDIENCE: service.audience, MAINWORTHY_JOB_ACCOUNT: service.account });
	expect(read.jobCaller).toEqual(service);
	expect(read.jobRunner).toBe(true);
	h.app.config.jobCaller = service;
	const server = serve(h.app, h.owner, { ui: null });
	try {
		const url = `http://127.0.0.1:${server.port}`;
		expect((await fetch(`${url}/health`)).status).toBe(200);
		expect((await fetch(`${url}/api/openapi.json`)).status).toBe(200);
		expect(
			(
				await fetch(`${url}/api/job`, {
					method: "POST",
					headers: { authorization: "Bearer forged" },
					body: '{"do":"tick"}',
				})
			).status,
		).toBe(401);
	} finally {
		await server.stop(true);
	}
});
test("the service token verifies signature, issuer, audience, account and validity without a shared secret", async () => {
	const keys = await generateKeyPair("RS256");
	const make = (
		claims: Record<string, unknown> = {},
		issuer = "https://accounts.google.com",
		audience = service.audience,
	) =>
		new SignJWT({ email: service.account, email_verified: true, ...claims })
			.setProtectedHeader({ alg: "RS256" })
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject("service-account-id")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(keys.privateKey);
	const verify = (token: string, configured = service) =>
		authenticateJob(`Bearer ${token}`, configured, async () => keys.publicKey);
	expect(await verify(await make())).toBe(true);
	expect(await verify(await make({ email: "other@example.iam.gserviceaccount.com" }))).toBe(false);
	expect(await verify(await make({ email_verified: false }))).toBe(false);
	expect(await verify(await make({}, "https://other.example.com"))).toBe(false);
	expect(await verify(await make({}, "https://accounts.google.com", "https://public.example.com"))).toBe(false);
	const expired = await new SignJWT({ email: service.account, email_verified: true })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer("https://accounts.google.com")
		.setAudience(service.audience)
		.setSubject("service-account-id")
		.setIssuedAt(1)
		.setExpirationTime(2)
		.sign(keys.privateKey);
	expect(await verify(expired)).toBe(false);
	const other = await generateKeyPair("RS256");
	const wrongSignature = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).sign(other.privateKey);
	expect(await verify(wrongSignature)).toBe(false);
	expect(await authenticateJob(null, service)).toBe(false);
	expect(await authenticateJob("Bearer forged", undefined)).toBe(false);
});
test("the registry service path and in-process runner execute the same durable job", async () => {
	h = await harness();
	const id = await h.app.database.write((db) =>
		db.transaction(() =>
			enqueueJob(db, { kind: "recover-disputes", key: "one", input: {}, actor: h.owner.id, acceptedAt: h.app.now() }),
		),
	);
	expect(await invokeService(h.app, jobOp, { do: "run", id })).toEqual({ ok: true, result: { ran: 1 }, seq: null });
	expect((await h.app.database.read((db) => jobById(db, id)))?.state).toBe("succeeded");
	expect(await invokeService(h.app, jobOp, { do: "run", id })).toEqual({ ok: true, result: { ran: 0 }, seq: null });
});
