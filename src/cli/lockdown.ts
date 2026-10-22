import { readFileSync } from "node:fs";

/** The application verifies its own credentials after exec, before opening a listener. */
export function verifyLockdown(): void {
	const mode = process.env.MAINWORTHY_LOCKDOWN ?? "0";
	if (mode === "0") return;
	if (mode !== "1") throw new Error("MAINWORTHY_LOCKDOWN must be 0 or 1");
	verifyLockdownStatus(readFileSync("/proc/self/status", "utf8"));
}

export function verifyLockdownStatus(status: string): void {
	for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
		if (!new RegExp(`^${field}:\\s+0+$`, "m").test(status)) {
			throw new Error(`lockdown: ${field} is not zero`);
		}
	}
	for (const field of ["Uid", "Gid"]) {
		if (!new RegExp(`^${field}:\\s+10001\\s+10001\\s+10001\\s+10001$`, "m").test(status)) {
			throw new Error(`lockdown: ${field} is not 10001`);
		}
	}
	if (!/^Groups:[\t ]*$/m.test(status) || !/^NoNewPrivs:\s+1$/m.test(status)) {
		throw new Error("lockdown: supplementary groups or no-new-privileges check failed");
	}
}
