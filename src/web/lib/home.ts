import { z } from "zod";
import { TAG } from "../../core/model.ts";
import { call } from "./api.ts";
import { deviceKey, deviceSession } from "./device.ts";
import { routeUrl } from "./router.ts";

export const Home = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("suite") }),
	z.object({ kind: z.literal("queue") }),
	z.object({ kind: z.literal("run"), ref: z.string().regex(/^R-[1-9]\d*$/) }),
	z.object({
		kind: z.literal("search"),
		text: z.string().max(1000),
		folder: z.string().max(1000),
		tag: z.string().refine((tag) => tag === "" || TAG.test(tag)),
	}),
]);
export type Home = z.infer<typeof Home>;

/** A home belongs to the signed-in person and project in this browser, as drafts do. */
export function readHome(project: string): Home {
	try {
		return Home.parse(JSON.parse(localStorage.getItem(deviceKey("home", project)) ?? "null"));
	} catch {
		return { kind: "suite" };
	}
}

/** False means the browser refused storage; the previous home is still in force. */
export function saveHome(project: string, home: Home): boolean {
	try {
		localStorage.setItem(deviceKey("home", project), JSON.stringify(Home.parse(home)));
		return true;
	} catch {
		return false;
	}
}

function homeUrl(project: string, home: Home): string {
	switch (home.kind) {
		case "suite":
		case "queue":
			return routeUrl({ project, screen: home.kind });
		case "run":
			return routeUrl({ project, screen: "runs", ref: home.ref });
		case "search": {
			const params = new URLSearchParams();
			if (home.text) params.set("text", home.text);
			if (home.folder) params.set("folder", home.folder);
			if (home.tag) params.set("tag", home.tag);
			return `${routeUrl({ project, screen: "suite" })}${params.size ? `?${params}` : ""}`;
		}
	}
}

/** Resolve before mounting a screen, so a missing target never starts failing detail reads. */
export async function resolveHome(project: string): Promise<{ url: string; missing: boolean }> {
	const home = readHome(project);
	const owner = deviceSession();
	let missing = false;
	if (home.kind === "run") {
		const id = Number(home.ref.slice(2));
		missing = true;
		if (Number.isSafeInteger(id)) {
			for (const state of ["planned", "change"]) {
				const runs = await call("find", { in: "runs", state, cursor: String(id + 1), limit: 1 }, { project, owner });
				if (runs.items.some((run) => run.ref === home.ref)) {
					missing = false;
					break;
				}
			}
		}
	} else if (home.kind === "search" && home.folder) {
		const folders = await call("find", { in: "folders" }, { project, owner });
		missing = !folders.items.some((folder) => folder.path === home.folder);
	}
	return { url: missing ? routeUrl({ project, screen: "suite" }) : homeUrl(project, home), missing };
}
