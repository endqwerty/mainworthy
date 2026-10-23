import { expect, test } from "bun:test";
import { GetReply } from "../src/core/replies.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { harness } from "./helpers.ts";

test("get reads an exact old result with diagnostics only in its project and with read permission", () => {
	const h = harness();
	try {
		const sent = h.call<{ results: number[] }>("report", {
			target: { session: "sample" },
			buildUrl: "https://example.com/build/42",
			results: [
				{
					test: { key: "checkout" },
					outcome: "fail",
					failure: { message: "wrong total", detail: "checkout.ts:42" },
					steps: [{ step: "coupon", outcome: "fail" }],
				},
			],
		});
		const id = sent.results[0];
		if (id === undefined) throw new Error("Expected result");
		for (let i = 0; i < 21; i++)
			h.call("report", {
				target: { session: `later-${i}` },
				results: [{ test: { key: "checkout" }, outcome: "pass" }],
			});
		const test = h.call<{ last: { id: number }[] }[]>("get", { refs: ["T-1"] })[0];
		expect(test?.last.some((result) => result.id === id)).toBe(false);
		expect(GetReply.parse(h.call("get", { refs: [`result:${id}`] }))).toMatchObject([
			{
				ref: `result:${id}`,
				id,
				test: "T-1",
				message: "wrong total",
				detail: "checkout.ts:42",
				steps: [{ step: "coupon", outcome: "fail" }],
				build: "https://example.com/build/42",
			},
		]);
		h.call("admin", { do: "project.create", key: "another", preset: "loose" });
		expect(
			invoke(h.app, OPS, { op: "get", project: "another", input: { refs: [`result:${id}`] }, actor: () => h.owner }),
		).toMatchObject({ ok: false, error: { code: "not_found" } });
		const recorder = h.actor("recorder", "ci", ["record"]);
		expect(h.raw("get", { refs: [`result:${id}`] }, recorder)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		for (const ref of ["result:999999", "result:-1", "result:1x", "result:999999999999999999999999999999999999"])
			expect(h.raw("get", { refs: [ref] })).toMatchObject({ ok: false, error: { code: "not_found" } });
	} finally {
		h.close();
	}
});
