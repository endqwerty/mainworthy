// After the owner merged the thread's pull request by rebase, the branch's own commits are not on `main` under
// their own ids, and T3 Code keeps showing them as changes. Moving the branch onto `origin/main` is safe only when
// nothing on it is unmerged, and `git reset --hard` does not ask: this does.
import { read, run } from "./run.ts";

export async function syncBranch(repo: string, push = true): Promise<string> {
	const git = (...args: string[]): Promise<string> => read(["git", ...args], { cwd: repo });
	const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch === "HEAD" || branch === "main") throw new Error(`${branch} is not a thread's branch`);
	if ((await git("status", "--porcelain")) !== "") throw new Error("the worktree has uncommitted changes");
	await git("fetch", "origin", "main");
	// A branch whose tree is main's loses nothing by a reset, whatever its commits are.
	const loses = (await run(["git", "diff", "--quiet", "origin/main", "HEAD"], { cwd: repo })).status !== 0;
	if (loses) {
		// `git cherry` marks a commit `-` when main has one with the same change, which is what a rebase merge
		// leaves. It skips merge commits, whose conflict resolutions main may not have.
		const unmerged = (await git("cherry", "origin/main", "HEAD")).split("\n").filter((line) => line.startsWith("+"));
		if (unmerged.length > 0)
			throw new Error(
				`${unmerged.length} commit(s) of ${branch} are not on origin/main, so nothing was reset:\n${unmerged.join("\n")}`,
			);
		const merges = (await git("rev-list", "--merges", "origin/main..HEAD")).split("\n").filter(Boolean);
		if (merges.length > 0)
			throw new Error(
				`${branch} has ${merges.length} merge commit(s) that origin/main does not hold, and its tree differs from main's: ` +
					`a conflict resolution may be lost, so nothing was reset (${merges.join(" ")}). Compare with \`git diff origin/main HEAD\`.`,
			);
	}
	await git("reset", "--hard", "origin/main");
	if (push) await git("push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`);
	const left = await git("rev-list", "--count", "origin/main..HEAD");
	if (left !== "0") throw new Error(`${left} commit(s) are still on ${branch} after the reset`);
	return `${branch} is at origin/main${push ? " and pushed" : ""}`;
}
