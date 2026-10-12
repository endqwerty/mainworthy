import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ReportInput, TargetIn } from "../core/ops.ts";
import { detectTarget } from "./ci-env.ts";

const fixtureDirectory = new URL("../../test/fixtures/ci-env/", import.meta.url);
const head = "9f3c2ab111111111111111111111111111111111";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const githubEvent = JSON.stringify({
	number: 482,
	pull_request: {
		number: 482,
		head: { sha: head, ref: "feature/coupon" },
		base: { sha: base, ref: "main" },
		title: "Apply checkout coupon",
		html_url: "https://github.com/acme/web/pull/482",
	},
});
type Detection = ReturnType<typeof detectTarget>;
type CommitTarget = Extract<TargetIn, { commit: string }>;

function detected(
	provider: string,
	job: string | null,
	attempt: number | null,
	buildUrl: string | null,
	fields: Partial<CommitTarget> = {},
): Detection {
	return {
		target: { commit: head, branch: "feature/coupon", repo: "acme/web", ...fields },
		job,
		attempt,
		buildUrl,
		provider,
		missing: [],
	};
}

const fixtures: { file: string; expected: Detection; event?: string }[] = [
	{ file: "github-push", expected: detected("github", "e2e", 2, "https://github.com/acme/web/actions/runs/812") },
	{
		file: "github-pr",
		event: githubEvent,
		expected: detected("github", "e2e", 1, "https://github.com/acme/web/actions/runs/813", {
			pr: 482,
			base,
			title: "Apply checkout coupon",
			url: "https://github.com/acme/web/pull/482",
		}),
	},
	{
		file: "github-pr-target",
		event: githubEvent,
		expected: detected("github", "unit", 3, "https://github.acme.example/acme/web/actions/runs/814", {
			pr: 482,
			base,
			title: "Apply checkout coupon",
			url: "https://github.com/acme/web/pull/482",
		}),
	},
	{
		file: "gitlab-push",
		expected: detected("gitlab", "e2e", null, "https://gitlab.example/acme/web/-/jobs/1458", { env: "staging" }),
	},
	{
		file: "gitlab-mr",
		expected: detected("gitlab", "e2e", null, "https://gitlab.example/acme/web/-/jobs/1459", {
			pr: 482,
			base,
			title: "Apply checkout coupon",
			url: "https://gitlab.example/acme/web/-/merge_requests/482",
		}),
	},
	{
		file: "gitlab-merged-results",
		expected: detected("gitlab", "unit", null, "https://gitlab.example/acme/web/-/pipelines/501", { pr: 482, base }),
	},
	{ file: "circle-push", expected: detected("circleci", "e2e", null, "https://circleci.com/gh/acme/web/500") },
	{
		file: "circle-pr",
		expected: detected("circleci", "e2e", null, "https://circleci.com/gh/acme/web/501", {
			pr: 482,
			url: "https://github.com/acme/web/pull/482",
		}),
	},
	{ file: "buildkite-push", expected: detected("buildkite", "e2e", 1, "https://buildkite.com/acme/web/50") },
	{ file: "buildkite-pr", expected: detected("buildkite", "e2e", 3, "https://buildkite.com/acme/web/51", { pr: 482 }) },
	{
		file: "jenkins-plain",
		expected: detected("jenkins", "web/e2e", null, "https://jenkins.example/job/web/job/e2e/802/"),
	},
	{
		file: "jenkins-branch",
		expected: detected(
			"jenkins",
			"web/feature%2Fcoupon",
			null,
			"https://jenkins.example/job/web/job/feature%252Fcoupon/2/",
		),
	},
	{
		file: "jenkins-pr",
		expected: detected("jenkins", "web/PR-482", null, "https://jenkins.example/job/web/job/PR-482/3/", {
			pr: 482,
			title: "Apply checkout coupon",
			url: "https://github.com/acme/web/pull/482",
		}),
	},
	{
		file: "azure-push",
		expected: detected("azure", "e2e", 2, "https://dev.azure.com/acme/Web%20Platform/_build/results?buildId=845"),
	},
	{
		file: "azure-pr",
		expected: detected("azure", "unit", 1, "https://dev.azure.com/acme/Web/_build/results?buildId=846", {
			repo: "web",
			pr: 482,
		}),
	},
	{
		file: "azure-github-pr",
		expected: detected("azure", "unit", 1, "https://dev.azure.com/acme/Web/_build/results?buildId=847", { pr: 482 }),
	},
	{
		file: "bitbucket-push",
		expected: detected("bitbucket", null, 1, "https://bitbucket.org/acme/web/pipelines/results/101", {
			env: "staging",
		}),
	},
	{
		file: "bitbucket-pr",
		expected: detected("bitbucket", null, 3, "https://bitbucket.org/acme/web/pipelines/results/102", { pr: 482, base }),
	},
];

describe("detectTarget fixture environments", () => {
	for (const fixture of fixtures) {
		test(fixture.file, async () => {
			const env = z
				.record(z.string(), z.string())
				.parse(await Bun.file(new URL(`${fixture.file}.json`, fixtureDirectory)).json());
			const paths: string[] = [];
			const actual = detectTarget(env, {
				readFile: (path) => {
					paths.push(path);
					return fixture.event ?? null;
				},
				git: () => {
					throw new Error("CI detection must not inspect local git");
				},
			});
			expect(actual).toEqual(fixture.expected);
			expect(TargetIn.safeParse(actual.target).success).toBe(true);
			expect(
				ReportInput.safeParse({
					target: actual.target,
					...(actual.job === null ? {} : { job: actual.job }),
					...(actual.attempt === null ? {} : { attempt: actual.attempt }),
					...(actual.buildUrl === null ? {} : { buildUrl: actual.buildUrl }),
					results: [{ test: { key: "example" }, outcome: "pass" }],
				}).success,
			).toBe(true);
			expect(paths).toEqual(fixture.event === undefined ? [] : ["/runner/event.json"]);
		});
	}
});

describe("detectTarget overrides and fallbacks", () => {
	test("all explicit overrides beat CI and the GitHub event", async () => {
		const env = z
			.record(z.string(), z.string())
			.parse(await Bun.file(new URL("github-pr.json", fixtureDirectory)).json());
		const actual = detectTarget(
			{
				...env,
				CASEBOOK_COMMIT: "cccccccccccccccccccccccccccccccccccccccc",
				CASEBOOK_BRANCH: "release/1.0",
				CASEBOOK_PR: "93",
				CASEBOOK_BASE: "dddddddddddddddddddddddddddddddddddddddd",
				CASEBOOK_REPO: "other/repo",
				CASEBOOK_ENV: "production",
				CASEBOOK_JOB: "smoke",
				CASEBOOK_ATTEMPT: "4",
				CASEBOOK_BUILD_URL: "https://ci.example/build/4",
			},
			{ readFile: () => githubEvent },
		);
		expect(actual).toEqual({
			target: {
				commit: "cccccccccccccccccccccccccccccccccccccccc",
				branch: "release/1.0",
				pr: 93,
				base: "dddddddddddddddddddddddddddddddddddddddd",
				repo: "other/repo",
				env: "production",
			},
			job: "smoke",
			attempt: 4,
			buildUrl: "https://ci.example/build/4",
			provider: "github",
			missing: [],
		});
	});

	test.each([null, "not json", '{"pull_request":{"head":{"sha":false}}}'])(
		"unreadable or invalid event: %j",
		(event) => {
			const actual = detectTarget(
				{
					GITHUB_ACTIONS: "true",
					GITHUB_SHA: head,
					GITHUB_HEAD_REF: "feature/coupon",
					GITHUB_REF: "refs/pull/482/merge",
					GITHUB_EVENT_PATH: "/event.json",
				},
				{ readFile: () => event },
			);
			expect(actual).toEqual({
				target: { commit: head, branch: "feature/coupon", pr: 482 },
				job: null,
				attempt: null,
				buildUrl: null,
				provider: "github",
				missing: [],
			});
		},
	);

	test("a throwing event reader falls back to environment", () => {
		expect(
			detectTarget(
				{ GITHUB_ACTIONS: "true", GITHUB_SHA: head, GITHUB_EVENT_PATH: "/event.json" },
				{
					readFile: () => {
						throw new Error("not readable");
					},
				},
			).target,
		).toEqual({ commit: head });
	});

	test("git supplies the target outside CI", () => {
		expect(detectTarget({}, { git: () => ({ commit: head, branch: "feature/coupon", repo: "acme/web" }) })).toEqual(
			detected("git", null, null, null),
		);
	});

	test("overrides also beat local git", () => {
		expect(
			detectTarget(
				{ CASEBOOK_BRANCH: "main", CASEBOOK_ATTEMPT: "2" },
				{ git: () => ({ commit: head, branch: "feature/coupon", repo: "acme/web" }) },
			),
		).toEqual(detected("git", null, 2, null, { branch: "main" }));
	});

	test.each([
		undefined,
		() => null,
		() => ({ branch: "main" }),
		() => {
			throw new Error("no git");
		},
	])("missing commit has exactly one missing field", (git) => {
		expect(detectTarget({}, git === undefined ? {} : { git })).toEqual({
			target: null,
			job: null,
			attempt: null,
			buildUrl: null,
			provider: git === undefined ? "unknown" : "git",
			missing: ["commit"],
		});
	});

	test("a missing CI commit never falls back to an unrelated checkout", () => {
		expect(detectTarget({ GITHUB_ACTIONS: "true", GITHUB_JOB: "e2e" }, { git: () => ({ commit: head }) })).toEqual({
			target: null,
			job: "e2e",
			attempt: null,
			buildUrl: null,
			provider: "github",
			missing: ["commit"],
		});
	});

	test("invalid explicit values do not silently fall back", () => {
		expect(
			detectTarget({
				GITHUB_ACTIONS: "true",
				GITHUB_SHA: head,
				GITHUB_RUN_ATTEMPT: "3",
				CASEBOOK_COMMIT: "bad",
				CASEBOOK_ATTEMPT: "-1",
			}),
		).toEqual({ target: null, job: null, attempt: null, buildUrl: null, provider: "github", missing: ["commit"] });
	});

	test("empty workflow expressions leave detected values intact", () => {
		const env = {
			GITHUB_ACTIONS: "true",
			GITHUB_SHA: head,
			GITHUB_REF: "refs/pull/482/merge",
			GITHUB_HEAD_REF: "feature/coupon",
			GITHUB_JOB: "e2e",
			GITHUB_RUN_ATTEMPT: "2",
			GITHUB_RUN_ID: "1",
			GITHUB_REPOSITORY: "acme/web",
		};
		const actual = detectTarget({
			...env,
			CASEBOOK_COMMIT: "",
			CASEBOOK_BRANCH: "  ",
			CASEBOOK_PR: "",
			CASEBOOK_BASE: "",
			CASEBOOK_REPO: "",
			CASEBOOK_ENV: "",
			CASEBOOK_JOB: "",
			CASEBOOK_ATTEMPT: "",
			CASEBOOK_BUILD_URL: "",
		});
		expect(actual).toEqual(detected("github", "e2e", 2, "https://github.com/acme/web/actions/runs/1", { pr: 482 }));
	});

	test("PR metadata follows its identity when overrides are applied", () => {
		const env = { GITHUB_ACTIONS: "true", GITHUB_SHA: head, GITHUB_EVENT_PATH: "/event.json" };
		const changed = detectTarget({ ...env, CASEBOOK_PR: "93" }, { readFile: () => githubEvent });
		expect(changed.target).toEqual({ commit: head, branch: "feature/coupon", pr: 93, base });
		const unchanged = detectTarget({ ...env, CASEBOOK_PR: "482" }, { readFile: () => githubEvent });
		expect(unchanged.target).toEqual({
			commit: head,
			branch: "feature/coupon",
			pr: 482,
			base,
			title: "Apply checkout coupon",
			url: "https://github.com/acme/web/pull/482",
		});
	});

	test("does not report tag names as source branches", () => {
		expect(
			detectTarget({ BUILDKITE: "true", BUILDKITE_COMMIT: head, BUILDKITE_BRANCH: "v1.0", BUILDKITE_TAG: "v1.0" })
				.target,
		).toEqual({ commit: head });
		expect(
			detectTarget({ JENKINS_URL: "https://jenkins.example", GIT_COMMIT: head, BRANCH_NAME: "v1.0", TAG_NAME: "v1.0" })
				.target,
		).toEqual({ commit: head });
	});

	test("detects CircleCI fork PR numbers from the dedicated variable or checkout ref", () => {
		expect(
			detectTarget({ CIRCLECI: "true", CIRCLE_SHA1: head, CIRCLE_BRANCH: "feature/coupon", CIRCLE_PR_NUMBER: "482" })
				.target,
		).toEqual({ commit: head, branch: "feature/coupon", pr: 482 });
		expect(detectTarget({ CIRCLECI: "true", CIRCLE_SHA1: head, CIRCLE_BRANCH: "pull/482" }).target).toEqual({
			commit: head,
			pr: 482,
		});
	});

	test("rejects partial, fractional, non-finite and unsafe integers", () => {
		for (const value of ["2oops", "2.5", "Infinity", "9007199254740992", "0", "-1"]) {
			const actual = detectTarget({ CASEBOOK_COMMIT: head, CASEBOOK_PR: value, CASEBOOK_ATTEMPT: value });
			expect(actual.target).toEqual({ commit: head });
			expect(actual.attempt).toBeNull();
		}
	});

	test("does not confuse a base branch name or all-zero sentinel with a base SHA", () => {
		const actual = detectTarget({
			GITLAB_CI: "true",
			CI_COMMIT_SHA: head,
			CI_COMMIT_BEFORE_SHA: "0".repeat(40),
			CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
		});
		expect(actual.target).toEqual({ commit: head });
	});

	test("preserves source branch slashes, and does not report a tag as a branch", () => {
		expect(
			detectTarget({
				TF_BUILD: "True",
				BUILD_SOURCEVERSION: head,
				BUILD_SOURCEBRANCH: "refs/heads/features/coupon/v2",
				BUILD_SOURCEBRANCHNAME: "v2",
			}).target,
		).toEqual({ commit: head, branch: "features/coupon/v2" });
		expect(
			detectTarget({
				GITHUB_ACTIONS: "true",
				GITHUB_SHA: head,
				GITHUB_REF: "refs/tags/v1.0",
				GITHUB_REF_NAME: "v1.0",
				GITHUB_REF_TYPE: "tag",
			}).target,
		).toEqual({ commit: head });
	});

	test("uses the first CircleCI PR URL when only the list is supplied", () => {
		expect(
			detectTarget({
				CIRCLECI: "true",
				CIRCLE_SHA1: head,
				CIRCLE_PULL_REQUESTS: "https://github.com/acme/web/pull/482,https://github.com/acme/web/pull/483",
			}).target,
		).toEqual({ commit: head, pr: 482, url: "https://github.com/acme/web/pull/482" });
	});

	test("keeps all returned strings within their wire-schema limits", () => {
		const actual = detectTarget({
			CASEBOOK_COMMIT: head,
			CASEBOOK_BRANCH: "b".repeat(300),
			CASEBOOK_REPO: "r".repeat(300),
			CASEBOOK_ENV: "e".repeat(100),
			CASEBOOK_BASE: "a".repeat(100),
			CASEBOOK_JOB: "j".repeat(200),
			CASEBOOK_BUILD_URL: "u".repeat(600),
		});
		expect(
			ReportInput.safeParse({
				target: actual.target,
				job: actual.job,
				buildUrl: actual.buildUrl,
				results: [{ test: { key: "test" }, outcome: "pass" }],
			}).success,
		).toBe(true);
	});

	test("never invents a base commit by truncating an over-long identifier", () => {
		expect(detectTarget({ CASEBOOK_COMMIT: head, CASEBOOK_BASE: "a".repeat(70) }).target).toEqual({ commit: head });
		expect(
			detectTarget({ GITLAB_CI: "true", CI_COMMIT_SHA: head, CI_COMMIT_BEFORE_SHA: "a".repeat(70) }).target,
		).toEqual({ commit: head });
	});
});
