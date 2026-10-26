import { expect, test } from "bun:test";
// @ts-expect-error The Worker is plain JavaScript, deployed as it is.
import { forward } from "../infra/edge/worker.js";

const env = { ORIGIN: "https://service.example.run.app", PROXY_SECRET: "s".repeat(40) };

test("the edge Worker forwards to the service with the proof and the visitor's address it alone sets", async () => {
	const sent: Request = forward(
		new Request("https://mainworthy.example/api/p/scratch/find?q=1", {
			method: "POST",
			headers: {
				"cf-connecting-ip": "198.51.100.7",
				"x-mainworthy-proxy": "forged",
				"x-mainworthy-client": "203.0.113.9",
				origin: "https://mainworthy.example",
				"content-type": "application/json",
			},
			body: '{"a":1}',
		}),
		env,
	);
	expect(sent.url).toBe("https://service.example.run.app/api/p/scratch/find?q=1");
	expect(sent.method).toBe("POST");
	expect(sent.headers.get("x-mainworthy-proxy")).toBe(env.PROXY_SECRET);
	expect(sent.headers.get("x-mainworthy-client")).toBe("198.51.100.7");
	// A page of the public address counts as the service's own; the app compares Origin with the Host it sees.
	expect(sent.headers.get("origin")).toBe("https://service.example.run.app");
	expect(sent.redirect).toBe("manual");
	expect(await sent.text()).toBe('{"a":1}');
});

test("another site's Origin passes unchanged, and a request without Cloudflare's address carries none", () => {
	const sent: Request = forward(
		new Request("https://mainworthy.example/api/session", {
			method: "POST",
			headers: { origin: "https://evil.example" },
		}),
		env,
	);
	expect(sent.headers.get("origin")).toBe("https://evil.example");
	expect(sent.headers.get("x-mainworthy-client")).toBe("");
});
