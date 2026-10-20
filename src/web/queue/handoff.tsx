import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { failureBrief, type HandoffReceipt } from "../../core/handoff.ts";
import type { QuestionItem } from "../../core/ops.ts";
import { call } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { queryKey } from "../lib/data.ts";
import { randomId } from "../lib/ids.ts";
import { type Binding, useBindings } from "../lib/keys.ts";
import { refUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, KeyCap } from "../ui/index.tsx";
import { FailureEvidence } from "./evidence.tsx";

/**
 * A failure question's way to a coding agent: `y` copies a brief to paste into any agent, and `h` asks the server
 * to send it to the agent the instance is configured to start (`handoff`), which says how the sending went.
 */
export function Handoff({ question, active }: { question: QuestionItem; active: () => boolean }) {
	const { project, session, setStatus } = useApp();
	const configured = session.projects.find((row) => row.key === project)?.handoff === true;
	const evidence = FailureEvidence.safeParse(question.evidence);
	const [sending, setSending] = useState(false);
	const input = { question: question.q };
	const status = useQuery({
		queryKey: queryKey({ project, op: "handoff-status", input }),
		queryFn: ({ signal }) => call("handoff-status", input, { project, signal }),
		enabled: configured,
		refetchInterval: (query) => (pending(query.state.data) ? 1_000 : false),
	});
	const facts = evidence.data;
	async function copy(): Promise<void> {
		if (!facts) return;
		const brief = failureBrief({
			project,
			question: question.q,
			title: question.title,
			url: new URL(refUrl({ project, ref: question.q }), window.location.origin).href,
			message: facts.message,
			tests: facts.tests,
			count: facts.count,
			target: facts.target,
			branch: facts.branch,
			scope: facts.scope,
		});
		setStatus(
			(await copyText(brief))
				? `Copied ${question.q} for an agent. Paste it into the one you use.`
				: `${question.q} could not be copied: this browser refused the clipboard.`,
		);
	}
	async function send(): Promise<void> {
		if (sending) return;
		setSending(true);
		try {
			await call("handoff", { question: question.q, cmd: randomId() }, { project });
			await status.refetch();
		} catch (error) {
			setStatus(error instanceof Error ? error.message : `${question.q} was not handed to the agent.`);
		} finally {
			setSending(false);
		}
	}
	const last = status.data ?? null;
	const busy = sending || pending(last);
	const keys: Binding[] = [
		{ key: "y", label: "Copy for an agent", handler: () => void copy(), applies: () => active() && Boolean(facts) },
		{
			key: "h",
			label: "Hand to the agent",
			handler: () => void send(),
			applies: () => active() && Boolean(facts) && configured && !busy,
		},
	];
	useBindings(keys);
	if (!facts) return null;
	return (
		<div className="queue-handoff">
			<div className="outs">
				<button className="out" type="button" onClick={() => void copy()}>
					<KeyCap>y</KeyCap> Copy for an agent
				</button>
				{configured && (
					<button className="out" type="button" disabled={busy} onClick={() => void send()}>
						<KeyCap>h</KeyCap> {last ? "Hand to the agent again" : "Hand to the agent"}
					</button>
				)}
			</div>
			{configured && last && (
				<p role="status" className={last.state === "failed" ? "hintbox" : "dim"}>
					{statusLine(last)}
				</p>
			)}
		</div>
	);
}

const pending = (receipt: HandoffReceipt | null | undefined): boolean =>
	receipt?.state === "queued" || receipt?.state === "sending";

function statusLine(receipt: HandoffReceipt): string {
	switch (receipt.state) {
		case "queued":
		case "sending":
			return "Sending to the agent…";
		case "sent":
			return `Sent to the agent ${age(receipt.at)}; its endpoint took it.`;
		case "failed":
			return receipt.error ?? "Not sent.";
	}
}
