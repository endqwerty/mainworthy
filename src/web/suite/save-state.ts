import type { Api } from "../../core/api.ts";
import type { Draft } from "../lib/drafts.ts";
import { nextSaveEffect, type SaveState, saveTransition } from "./save-lifecycle.ts";

export class SaveCommands {
	readonly pending = new Map<string, Promise<void>>();
	private readonly states = new Map<string, SaveState>();
	restore(draft: Draft): void {
		const state = this.states.get(draft.id);
		const cmd = state?.kind === "sent" ? state.input.cmd : state && state.kind !== "unsent" ? state.cmd : undefined;
		if (
			(draft.sent && cmd !== draft.sent.input.cmd) ||
			(state?.kind === "adopted" && draft.id === state.ref) ||
			(state?.kind === "succeeded" && !draft.sent && draft.submission.kind !== "waiting")
		)
			this.clear(draft.id);
		if (!this.states.has(draft.id) && draft.sent) this.sent(draft.id, draft.sent.input);
	}
	sent(id: string, input: Api["propose"]["input"]): void {
		this.states.set(id, saveTransition(this.states.get(id) ?? { kind: "unsent" }, { kind: "sent", input }));
	}
	succeeded(id: string, reply: Api["propose"]["reply"], cmd: string): void {
		this.states.set(id, saveTransition(this.states.get(id) ?? { kind: "unsent" }, { kind: "succeeded", cmd, reply }));
	}
	reply(id: string): Api["propose"]["reply"] | null {
		const effect = nextSaveEffect(this.states.get(id) ?? { kind: "unsent" });
		return effect.kind === "read-back" ? effect.reply : null;
	}
	adopt(id: string, ref: string, version: number): void {
		this.states.set(id, saveTransition(this.states.get(id) ?? { kind: "unsent" }, { kind: "adopted", ref, version }));
	}
	adoptedRef(id: string): string | undefined {
		const state = this.states.get(id);
		return state?.kind === "adopted" ? state.ref : undefined;
	}
	clear(id: string): void {
		this.states.delete(id);
	}
}
