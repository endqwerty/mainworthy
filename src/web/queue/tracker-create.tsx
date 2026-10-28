import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { QuestionItem } from "../../core/ops.ts";
import { TrackerPreview, TrackerReceipt } from "../../core/tracker.ts";
import { call } from "../lib/api.ts";
import { queryKey } from "../lib/data.ts";
import { randomId } from "../lib/ids.ts";
import { useBindings } from "../lib/keys.ts";
import { useApp } from "../ui/context.tsx";
import { FailureEvidence } from "./evidence.tsx";

/** `keyed` false leaves the key to another card on the screen: its button still works. */
export function TrackerCreate({
	question,
	active,
	keyed = true,
}: {
	question: QuestionItem;
	active: () => boolean;
	keyed?: boolean;
}) {
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
		queryFn: async ({ signal }) =>
			TrackerPreview.parse(await call("tracker", { do: "preview", result: sample ?? 0, cmd }, { project, signal })),
		staleTime: Infinity,
	});
	const last = status.data ?? receipt;
	const busy = sending || last?.state === "queued" || last?.state === "sending";
	const label = destination?.startsWith("jira:") ? "Create tracker issue" : "Create GitHub issue";
	useBindings(
		keyed
			? [
					{
						key: "alt+g",
						label,
						handler: () => {
							void preview.refetch();
							setReview(true);
						},
						applies: () => offered && active() && !busy && !last?.issue,
					},
				]
			: [],
	);
	async function send() {
		if (!sample || busy || !preview.data || preview.isFetching || preview.error) return;
		setSending(true);
		setError(null);
		try {
			setReceipt(
				TrackerReceipt.parse(
					await call("tracker", { do: "create", result: sample, cmd, confirm: preview.data.confirm }, { project }),
				),
			);
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
				<button
					className="out"
					type="button"
					disabled={busy}
					onClick={() => {
						void preview.refetch();
						setReview(true);
					}}
				>
					{label}
				</button>
			)}
			{review && (
				<div className="hintbox" tabIndex={-1} ref={reviewElement}>
					<p>
						The issue includes the failure, target, build URL and recorded case content. The repository may be public.
					</p>
					<pre className="log">
						{preview.data
							? `Destination: ${preview.data.destination}\nTitle: ${preview.data.title}\n\n${preview.data.body}`
							: preview.error
								? preview.error.message
								: "Reading the recorded evidence…"}
					</pre>
					<button
						type="button"
						disabled={!preview.data || preview.isFetching || Boolean(preview.error) || busy}
						onClick={() => void send()}
					>
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
