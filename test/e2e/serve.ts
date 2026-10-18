import { z } from "zod";
import { start, VERSION } from "../../src/app/start.ts";
import { defaultConfig, SESSION_LIFETIMES } from "../../src/server/kernel/app.ts";
import { archiveRoutes } from "../../src/surfaces/archive.ts";
import { docsRoutes } from "../../src/surfaces/docs/site.ts";
import ui from "../../src/web/index.html";

// The instance's clock, which a test moves forward instead of waiting for an invitation to run out:
// `POST /test/clock` with `{ "advanceMs": n }`, from a session that administers.
let ahead = 0;
const Advance = z.object({ advanceMs: z.number().int().min(0) });

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
		proxy: null,
		mail: defaultConfig(process.env).mail,
		...(defaultConfig(process.env).oidc ? { oidc: defaultConfig(process.env).oidc } : {}),
		// The browser tests hash a password for every person they make and every sign-in. At what the build
		// ships with, that is most of their time; the hashing itself is tested where it is written.
		passwordCost: { memoryCost: 8, timeCost: 1 },
		...(process.env.MAINWORTHY_PUBLIC_URL ? { publicUrl: process.env.MAINWORTHY_PUBLIC_URL } : {}),
	},
	(app, owner) => ({
		ui,
		routes: {
			...archiveRoutes(app, owner),
			"/test/clock": async (req, session) => {
				if (!session.actor(0)?.can.includes("admin")) return new Response(null, { status: 403 });
				ahead += Advance.parse(await req.json()).advanceMs;
				return Response.json({ ok: true, result: { ahead } });
			},
		},
		open: docsRoutes(VERSION),
	}),
	{ now: () => Date.now() + ahead, firstProject: process.env.MAINWORTHY_FIRST_PROJECT ?? "scratch" },
);
console.info(instance.url);
for (const signal of ["SIGTERM", "SIGINT"] satisfies NodeJS.Signals[])
	process.on(signal, () => {
		void instance.stop().then(() => process.exit(0));
	});
