import { z } from "zod";
import { TAG } from "../../core/model.ts";
import { deviceKey } from "./device.ts";
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

export function homeUrl(project: string): string {
	const home = readHome(project);
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
