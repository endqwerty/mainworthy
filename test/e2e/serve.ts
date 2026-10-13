import { SESSION_LIFETIMES } from "../../src/server/kernel/app.ts";
import { start, VERSION } from "../../src/server/start.ts";
import { archiveRoutes } from "../../src/surfaces/archive.ts";
import { docsRoutes } from "../../src/surfaces/docs/site.ts";
import ui from "../../src/web/index.html";

const instance = start(
	{
		dataDir: process.env.MAINWORTHY_DATA ?? "/tmp/mainworthy-ui",
		host: "127.0.0.1",
		port: Number(process.env.MAINWORTHY_PORT ?? 7440),
		mode: process.env.MAINWORTHY_MODE === "server" ? "server" : "local",
		owner: "robin",
		ownerToken: process.env.MAINWORTHY_OWNER_TOKEN ?? null,
		commit: null,
		...SESSION_LIFETIMES,
	},
	(app, owner) => ({ ui, routes: archiveRoutes(app, owner), open: docsRoutes(VERSION) }),
);
console.info(instance.url);
for (const signal of ["SIGTERM", "SIGINT"] satisfies NodeJS.Signals[])
	process.on(signal, () => {
		void instance.stop().then(() => process.exit(0));
	});
