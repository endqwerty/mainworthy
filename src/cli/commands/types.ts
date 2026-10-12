import type { Args, Flag } from "../args.ts";
import type { Client } from "../client.ts";

/** An adapter supplies presentation and input translation; writes still use the shared operation client. */
export type AdapterCommand = {
	name: string;
	summary: string;
	usage: string;
	flags: readonly Flag[];
	run: (args: Args, client: Client) => Promise<number>;
};
