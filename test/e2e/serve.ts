import { start } from "../../src/server/start.ts";
import ui from "../../src/web/index.html";

const instance = start(
	{
		dataDir: process.env.CASEBOOK_DATA ?? "/tmp/casebook-ui",
		host: "127.0.0.1",
		port: Number(process.env.CASEBOOK_PORT ?? 7440),
		mode: process.env.CASEBOOK_MODE === "server" ? "server" : "local",
		owner: "daniel",
		ownerToken: process.env.CASEBOOK_OWNER_TOKEN ?? null,
	},
	() => ({ ui }),
);
console.info(instance.url);
for (const signal of ["SIGTERM", "SIGINT"] satisfies NodeJS.Signals[])
	process.on(signal, () => {
		void instance.stop().then(() => process.exit(0));
	});
