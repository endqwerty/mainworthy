import type { Api } from "../../core/api.ts";

export type SaveState =
	| { kind: "unsent" }
	| { kind: "sent"; input: Api["propose"]["input"] }
	| { kind: "succeeded"; cmd: string; reply: Api["propose"]["reply"] }
	| { kind: "adopted"; cmd: string; ref: string; version: number };
export type SaveEvent =
	| { kind: "sent"; input: Api["propose"]["input"] }
	| { kind: "succeeded"; cmd: string; reply: Api["propose"]["reply"] }
	| { kind: "adopted"; ref: string; version: number }
	| { kind: "refused" }
	| { kind: "read-failed" };

export function saveTransition(state: SaveState, event: SaveEvent): SaveState {
	switch (event.kind) {
		case "sent":
			return state.kind === "unsent" ? event : state;
		case "succeeded":
			return state.kind === "sent" || state.kind === "unsent" ? event : state;
		case "adopted":
			return state.kind === "succeeded" ? { ...event, cmd: state.cmd } : state;
		case "refused":
			return state.kind === "sent" ? { kind: "unsent" } : state;
		case "read-failed":
			return state;
	}
}

export function nextSaveEffect(state: SaveState) {
	switch (state.kind) {
		case "unsent":
			return { kind: "send" } as const;
		case "sent":
			return { kind: "recover", input: state.input } as const;
		case "succeeded":
			return { kind: "read-back", reply: state.reply } as const;
		case "adopted":
			return { kind: "complete", ref: state.ref, version: state.version } as const;
	}
}
