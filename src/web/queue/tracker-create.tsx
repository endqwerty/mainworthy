import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { QuestionItem } from "../../core/ops.ts";
import type { TrackerReceipt } from "../../core/tracker.ts";
import { call } from "../lib/api.ts";
import { queryKey } from "../lib/data.ts";
import { randomId } from "../lib/ids.ts";
import { useBindings } from "../lib/keys.ts";
import { useApp } from "../ui/context.tsx";
import { FailureEvidence } from "./evidence.tsx";

export function TrackerCreate({ question, active }: { question: QuestionItem; active: () => boolean }) {
	const { project, session } = useApp();
	const destination = session.projects.find((row) => row.key === project)?.tracker;
	const sample = FailureEvidence.safeParse(question.evidence).data?.sample;
	const offered = question.kind === "failure" && Boolean(destination) && Boolean(sample);
	const [review, setReview] = useState(false);
	const reviewElement = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (review) reviewElement.current?.focus();
	}, [review]);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [receipt, setReceipt] = useState<TrackerReceipt | null>(null);
	const [cmd] = useState(randomId);
	const input = { id: receipt?.id ?? cmd };
	const status = useQuery({
		queryKey: queryKey({ project, op: "tracker-status", input }),
		queryFn: ({ signal }) => call("tracker-status", input, { project, signal }),
		enabled: receipt !== null,
		refetchInterval: (query) =>
			!query.state.data || ["queued", "sending"].includes(query.state.data.state) ? 500 : false,
	});
	const preview = useQuery({
		queryKey: [project, "tracker-preview", sample],
		enabled: offered && review,
		queryFn: async () => {
			const rows = await call("get", { refs: [`result:${sample}`] }, { project });
			const result = z
				.object({
					message: z.string().nullable(),
					detail: z.string().nullable(),
					version: z.number().nullable(),
					case: z.string().nullable(),
					location: z.object({ label: z.string() }),
					build: z.string().nullable(),
				})
				.parse(rows[0]);
			const caseRef = result.case;
			const recorded =
				caseRef && result.version !== null
					? await call("get", { refs: [caseRef], version: result.version, as: "md" }, { project })
					: [];
			const content = recorded.length
				? z.object({ md: z.string() }).parse(recorded[0]).md
				: "No recorded case content.";
			return [
				`Destination: ${destination}`,
				`Result: ${sample}`,
				`Target: ${result.location.label}`,
				`Build: ${result.build ?? "not provided"}`,
				"",
				"Failure",
				result.message ?? "No failure message was reported.",
				result.detail ?? "",
				"",
				content,
			].join("\n");
		},
	});
	const last = status.data ?? receipt;
	const busy = sending || last?.state === "queued" || last?.state === "sending";
	const label = destination?.startsWith("jira:") ? "Create tracker issue" : "Create GitHub issue";
	useBindings([
		{
			key: "alt+g",
			label: `${label} for ${question.q}`,
			handler: () => setReview(true),
			applies: () => offered && active() && !busy && !last?.issue,
		},
	]);
	async function send() {
		if (!sample || busy) return;
		setSending(true);
		setError(null);
		try {
			setReceipt(await call("tracker", { do: "create", result: sample, cmd }, { project }));
			setReview(false);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "The issue could not be created.");
		} finally {
			setSending(false);
		}
	}
	if (!offered) return null;
	return (
		<div className="tracker-create">
			{!last && (
				<button className="out" type="button" disabled={busy} onClick={() => setReview(true)}>
					{label}
				</button>
			)}
			{review && (
				<div className="hintbox" tabIndex={-1} ref={reviewElement}>
					<p>
						The issue includes the failure, target, build URL and recorded case content. The repository may be public.
					</p>
					<pre className="log">
						{preview.data ?? (preview.error ? preview.error.message : "Reading the recorded evidence…")}
					</pre>
					<button type="button" disabled={!preview.data || busy} onClick={() => void send()}>
						Send to tracker
					</button>
					<button type="button" onClick={() => setReview(false)}>
						Cancel
					</button>
				</div>
			)}
			{busy && <p role="status">Creating the issue…</p>}
			{last?.issue && (
				<p role="status">
					<a href={last.issue.url} target="_blank" rel="noreferrer">
						{last.issue.ref}
					</a>
				</p>
			)}
			{(error || last?.error || status.error) && (
				<p role="status" className="hintbox">
					{error ?? last?.error ?? status.error?.message}
				</p>
			)}
		</div>
	);
}
