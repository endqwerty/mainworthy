import { z } from "zod";
import { TargetIn } from "../core/ops.ts";

type Environment = Record<string, string | undefined>;
type CommitTarget = Extract<TargetIn, { commit: string }>;
type TargetFields = Omit<Partial<CommitTarget>, "commit"> & { commit?: string | undefined };
type Source = {
	provider: "github" | "gitlab" | "circleci" | "buildkite" | "jenkins" | "azure" | "bitbucket" | "git" | "unknown";
	fields: TargetFields;
	job?: string | undefined;
	attempt?: number | undefined;
	buildUrl?: string | undefined;
};
type Options = {
	git?: () => { commit?: string; branch?: string; repo?: string } | null;
	readFile?: (path: string) => string | null;
};

const eventString = z.string().optional().catch(undefined);
const eventCommit = z.string().min(7).max(64).optional().catch(undefined);
const eventNumber = z.number().int().positive().optional().catch(undefined);
const GitHubEvent = z.object({
	number: eventNumber,
	before: eventCommit,
	repository: z.object({ full_name: eventString }).optional().catch(undefined),
	pull_request: z
		.object({
			number: eventNumber,
			head: z.object({ sha: eventCommit, ref: eventString }).optional().catch(undefined),
			base: z.object({ sha: eventCommit }).optional().catch(undefined),
			title: eventString,
			html_url: eventString,
		})
		.optional()
		.catch(undefined),
});

function text(value: string | undefined, limit?: number): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? (limit === undefined ? trimmed : trimmed.slice(0, limit)) : undefined;
}

function integer(value: string | undefined, minimum = 1): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

function enabled(value: string | undefined): boolean {
	return value?.toLowerCase() === "true";
}

function baseCommit(value: string | undefined): string | undefined {
	const sha = text(value);
	return sha && sha.length <= 64 && !/^0+$/.test(sha) ? sha : undefined;
}

function branch(value: string | undefined): string | undefined {
	const ref = text(value);
	if (ref?.startsWith("refs/tags/") || ref?.startsWith("refs/pull/")) return undefined;
	return ref?.replace(/^refs\/heads\//, "");
}

function repoName(value: string | undefined): string | undefined {
	const repo = text(value);
	if (repo === undefined) return undefined;
	let path = repo;
	if (repo.includes("://")) {
		try {
			path = new URL(repo).pathname;
		} catch {
			return undefined;
		}
	} else {
		const scp = /^(?:[^/@]+@)?[^/:]+:(.+)$/.exec(repo);
		path = scp?.[1] ?? repo;
	}
	return text(
		path
			.replace(/^\/+/, "")
			.replace(/\/+$/, "")
			.replace(/\.git$/, ""),
	);
}

function prFromUrl(value: string | undefined): number | undefined {
	return integer(/\/(?:pull|pull-requests|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(value ?? "")?.[1]);
}

function github(env: Environment, options: Options): Source {
	let event: z.infer<typeof GitHubEvent> | undefined;
	const path = text(env.GITHUB_EVENT_PATH);
	if (path !== undefined && options.readFile !== undefined) {
		try {
			const content = options.readFile(path);
			if (content !== null) {
				const raw: unknown = JSON.parse(content);
				const parsed = GitHubEvent.safeParse(raw);
				if (parsed.success) event = parsed.data;
			}
		} catch {
			event = undefined;
		}
	}
	const pull = event?.pull_request;
	const pr =
		integer(/^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(env.GITHUB_REF ?? "")?.[1]) ?? pull?.number ?? event?.number;
	const isPr = pr !== undefined || pull !== undefined || env.GITHUB_EVENT_NAME?.startsWith("pull_request") === true;
	const repo = text(env.GITHUB_REPOSITORY) ?? event?.repository?.full_name;
	const run = text(env.GITHUB_RUN_ID);
	const server = (text(env.GITHUB_SERVER_URL) ?? "https://github.com").replace(/\/+$/, "");
	return {
		provider: "github",
		fields: {
			commit: isPr ? (pull?.head?.sha ?? text(env.GITHUB_SHA)) : text(env.GITHUB_SHA),
			branch:
				text(env.GITHUB_HEAD_REF) ??
				(isPr ? pull?.head?.ref : undefined) ??
				branch(env.GITHUB_REF) ??
				(isPr || env.GITHUB_REF_TYPE === "tag" || env.GITHUB_REF?.startsWith("refs/tags/")
					? undefined
					: text(env.GITHUB_REF_NAME)),
			repo,
			pr,
			base: baseCommit(isPr ? pull?.base?.sha : event?.before),
			title: isPr ? pull?.title : undefined,
			url: isPr ? pull?.html_url : undefined,
		},
		job: text(env.GITHUB_JOB),
		attempt: integer(env.GITHUB_RUN_ATTEMPT),
		buildUrl: repo !== undefined && run !== undefined ? `${server}/${repo}/actions/runs/${run}` : undefined,
	};
}

function source(env: Environment, options: Options): Source {
	if (enabled(env.GITHUB_ACTIONS)) return github(env, options);
	if (enabled(env.GITLAB_CI)) {
		const pr = integer(env.CI_MERGE_REQUEST_IID);
		const project = text(env.CI_MERGE_REQUEST_PROJECT_URL) ?? text(env.CI_PROJECT_URL);
		return {
			provider: "gitlab",
			fields: {
				commit: text(env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA) ?? text(env.CI_COMMIT_SHA),
				branch:
					text(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME) ??
					text(env.CI_COMMIT_BRANCH) ??
					(env.CI_COMMIT_TAG ? undefined : branch(env.CI_COMMIT_REF_NAME)),
				repo: text(env.CI_PROJECT_PATH),
				pr,
				base:
					baseCommit(env.CI_MERGE_REQUEST_DIFF_BASE_SHA) ??
					baseCommit(env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA) ??
					baseCommit(env.CI_COMMIT_DEFAULT_BRANCH_BASE_SHA) ??
					baseCommit(env.CI_COMMIT_BEFORE_SHA),
				env: text(env.CI_ENVIRONMENT_NAME),
				title: text(env.CI_MERGE_REQUEST_TITLE),
				url:
					pr !== undefined && project !== undefined
						? `${project.replace(/\/+$/, "")}/-/merge_requests/${pr}`
						: undefined,
			},
			job: text(env.CI_JOB_NAME),
			buildUrl: text(env.CI_JOB_URL) ?? text(env.CI_PIPELINE_URL),
		};
	}
	if (enabled(env.CIRCLECI)) {
		const url = text(env.CIRCLE_PULL_REQUEST) ?? text(env.CIRCLE_PULL_REQUESTS?.split(",")[0]);
		const owner = text(env.CIRCLE_PROJECT_USERNAME);
		const name = text(env.CIRCLE_PROJECT_REPONAME);
		const refPr = integer(/^(?:refs\/)?pull\/(\d+)(?:\/(?:head|merge))?$/.exec(env.CIRCLE_BRANCH ?? "")?.[1]);
		return {
			provider: "circleci",
			fields: {
				commit: text(env.CIRCLE_SHA1),
				branch: refPr === undefined ? text(env.CIRCLE_BRANCH) : undefined,
				repo: owner !== undefined && name !== undefined ? `${owner}/${name}` : repoName(env.CIRCLE_REPOSITORY_URL),
				pr: integer(env.CIRCLE_PR_NUMBER) ?? prFromUrl(url) ?? refPr,
				url,
			},
			job: text(env.CIRCLE_JOB),
			buildUrl: text(env.CIRCLE_BUILD_URL),
		};
	}
	if (enabled(env.BUILDKITE)) {
		const retries = integer(env.BUILDKITE_RETRY_COUNT, 0);
		return {
			provider: "buildkite",
			fields: {
				commit: text(env.BUILDKITE_COMMIT),
				branch: text(env.BUILDKITE_TAG) === undefined ? text(env.BUILDKITE_BRANCH) : undefined,
				repo: repoName(env.BUILDKITE_REPO),
				pr: integer(env.BUILDKITE_PULL_REQUEST),
			},
			job: text(env.BUILDKITE_STEP_KEY) ?? text(env.BUILDKITE_LABEL),
			attempt: retries !== undefined && retries < Number.MAX_SAFE_INTEGER ? retries + 1 : undefined,
			buildUrl: text(env.BUILDKITE_BUILD_URL),
		};
	}
	if (text(env.JENKINS_URL) !== undefined || text(env.JENKINS_HOME) !== undefined) {
		return {
			provider: "jenkins",
			fields: {
				commit: text(env.GIT_COMMIT),
				branch:
					text(env.TAG_NAME) !== undefined
						? undefined
						: (text(env.CHANGE_BRANCH) ??
							text(env.BRANCH_NAME) ??
							(text(env.GIT_LOCAL_BRANCH) ?? text(env.GIT_BRANCH))?.replace(
								/^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/,
								"",
							)),
				repo: repoName(env.GIT_URL),
				pr: integer(env.CHANGE_ID),
				title: text(env.CHANGE_TITLE),
				url: text(env.CHANGE_URL),
			},
			job: text(env.JOB_NAME),
			buildUrl: text(env.BUILD_URL),
		};
	}
	if (enabled(env.TF_BUILD)) {
		const collection = text(env.SYSTEM_COLLECTIONURI) ?? text(env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI);
		const project = text(env.SYSTEM_TEAMPROJECT);
		const build = text(env.BUILD_BUILDID);
		return {
			provider: "azure",
			fields: {
				commit: text(env.SYSTEM_PULLREQUEST_SOURCECOMMITID) ?? text(env.BUILD_SOURCEVERSION),
				branch:
					branch(env.SYSTEM_PULLREQUEST_SOURCEBRANCH) ??
					branch(env.BUILD_SOURCEBRANCH) ??
					(env.BUILD_SOURCEBRANCH?.startsWith("refs/") ? undefined : text(env.BUILD_SOURCEBRANCHNAME)),
				repo: text(env.BUILD_REPOSITORY_NAME) ?? repoName(env.BUILD_REPOSITORY_URI),
				pr: integer(env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER) ?? integer(env.SYSTEM_PULLREQUEST_PULLREQUESTID),
			},
			job: text(env.SYSTEM_JOBNAME) ?? text(env.SYSTEM_JOBDISPLAYNAME),
			attempt: integer(env.SYSTEM_JOBATTEMPT),
			buildUrl:
				collection !== undefined && project !== undefined && build !== undefined
					? `${collection.replace(/\/+$/, "")}/${encodeURIComponent(project)}/_build/results?buildId=${encodeURIComponent(build)}`
					: undefined,
		};
	}
	if (text(env.BITBUCKET_BUILD_NUMBER) !== undefined || text(env.BITBUCKET_PIPELINE_UUID) !== undefined) {
		const repo =
			text(env.BITBUCKET_REPO_FULL_NAME) ??
			repoName(env.BITBUCKET_GIT_HTTP_ORIGIN) ??
			repoName(env.BITBUCKET_GIT_SSH_ORIGIN);
		const build = text(env.BITBUCKET_BUILD_NUMBER);
		return {
			provider: "bitbucket",
			fields: {
				commit: text(env.BITBUCKET_COMMIT),
				branch: text(env.BITBUCKET_BRANCH),
				repo,
				pr: integer(env.BITBUCKET_PR_ID),
				base: baseCommit(env.BITBUCKET_PR_DESTINATION_COMMIT),
				env: text(env.BITBUCKET_DEPLOYMENT_ENVIRONMENT),
			},
			attempt: integer(env.BITBUCKET_STEP_RUN_NUMBER),
			buildUrl:
				repo !== undefined && build !== undefined
					? `https://bitbucket.org/${repo}/pipelines/results/${build}`
					: undefined,
		};
	}
	if (options.git !== undefined) {
		try {
			return { provider: "git", fields: options.git() ?? {} };
		} catch {
			return { provider: "git", fields: {} };
		}
	}
	return { provider: "unknown", fields: {} };
}

function override(env: Environment, name: string, fallback: string | undefined): string | undefined {
	return text(env[name]) ?? fallback;
}

/**
 * Detects a commit target and report metadata from supplied CI variables, with CASEBOOK_* overrides first.
 * Reads GitHub event JSON and local git only through supplied callbacks; never accesses process state or I/O.
 * Empty overrides count as unset; invalid non-empty overrides never fall back. PR/repo overrides that change
 * identity discard stale PR title/URL. Missing/invalid commits return null and ["commit"]. Unavailable counters
 * and job names return null.
 * PR event payloads identify the change by its head SHA, including pull_request_target. A caller testing the base
 * checkout must supply CASEBOOK_COMMIT for that checkout. Over-long base identifiers are omitted, never shortened.
 */
export function detectTarget(
	env: Environment,
	options: Options = {},
): {
	target: TargetIn | null;
	job: string | null;
	attempt: number | null;
	buildUrl: string | null;
	provider: string;
	missing: string[];
} {
	const detected = source(env, options);
	const fields = detected.fields;
	const prOverride = text(env.CASEBOOK_PR);
	const pr = prOverride === undefined ? fields.pr : integer(prOverride);
	const repo = text(override(env, "CASEBOOK_REPO", fields.repo), 200);
	const changedPrIdentity = pr !== fields.pr || repo !== text(fields.repo, 200);
	const values = {
		commit: override(env, "CASEBOOK_COMMIT", fields.commit),
		branch: text(override(env, "CASEBOOK_BRANCH", fields.branch), 200),
		repo,
		pr,
		base: baseCommit(override(env, "CASEBOOK_BASE", fields.base)),
		env: text(override(env, "CASEBOOK_ENV", fields.env), 60),
		title: changedPrIdentity ? undefined : text(fields.title, 300),
		url: changedPrIdentity ? undefined : text(fields.url, 500),
	};
	const target = TargetIn.safeParse(
		Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
	);
	return {
		target: target.success ? target.data : null,
		job: text(override(env, "CASEBOOK_JOB", detected.job), 120) ?? null,
		attempt: (text(env.CASEBOOK_ATTEMPT) === undefined ? detected.attempt : integer(env.CASEBOOK_ATTEMPT)) ?? null,
		buildUrl: text(override(env, "CASEBOOK_BUILD_URL", detected.buildUrl), 500) ?? null,
		provider: detected.provider,
		missing: target.success ? [] : ["commit"],
	};
}
