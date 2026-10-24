import { resolve } from "node:path";

/** Keep benchmark output usable in public logs without recording workstation paths. */
export function publicLog(text: string, root = resolve(import.meta.dir, "..")): string {
	return text
		.replaceAll(`${root}/`, "")
		.replaceAll(root, ".")
		.replace(/\/(?:Volumes|Users)\/[^\s"']*/g, "<local-path>");
}
