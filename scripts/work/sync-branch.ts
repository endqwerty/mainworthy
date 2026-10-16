// After the owner merged the thread's pull request by rebase, the branch's own commits are not on `main` under
// their own ids, and T3 Code keeps showing them as changes. Moving the branch onto `origin/main` is safe only when
// nothing on it is unmerged, and `git reset --hard` does not ask: this does.
import { read } from "./run.ts";

export async function syncBranch(repo: string, push = true): Promise<string> {
	const git = (...args: string[]): Promise<string> => read(["git", ...args], { cwd: repo });
	const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch === "HEAD" || branch === "main") throw new Error(`${branch} is not a thread's branch`);
	if ((await git("status", "--porcelain")) !== "") throw new Error("the worktree has uncommitted changes");
	await git("fetch", "origin", "main");
	// `git cherry` marks a commit `-` when main has one with the same change, which is what a rebase merge leaves.
	const unmerged = (await git("cherry", "origin/main", "HEAD")).split("\n").filter((line) => line.startsWith("+"));
	if (unmerged.length > 0)
		throw new Error(
			`${unmerged.length} commit(s) of ${branch} are not on origin/main, so nothing was reset:\n${unmerged.join("\n")}`,
		);
	await git("reset", "--hard", "origin/main");
	if (push) await git("push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`);
	const left = await git("rev-list", "--count", "origin/main..HEAD");
	if (left !== "0") throw new Error(`${left} commit(s) are still on ${branch} after the reset`);
	return `${branch} is at origin/main${push ? " and pushed" : ""}`;
}
