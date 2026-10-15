import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Api } from "../../core/api.ts";
import { ATTACHMENT_LIMITS, AttachmentInput, attachmentBytes } from "../../core/attachments.ts";
import type { ReportReceipt } from "../../core/ops.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { deviceKey, deviceSession, sessionCurrent } from "../lib/device.ts";
import { randomId } from "../lib/ids.ts";
import { type Binding, useBindings } from "../lib/keys.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { ResultAttachments } from "../ui/attachments.tsx";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, KeyCap, ListRow, ProducerGlyph } from "../ui/index.tsx";
import { type Fill, outcomeName, Run, RunCase, type RunOutcome, Slot, tallyText } from "./models.ts";

/**
 * Notes typed for the slots of one run and not yet on the server, by slot id. Each note has its own key, so two
 * tabs on one run never write over each other's notes. Storage may be full or off.
 */
function readNotes(prefix: string): Record<string, string> {
	const notes: Record<string, string> = {};
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(prefix)) continue;
			const text = localStorage.getItem(key);
			if (text) notes[key.slice(prefix.length)] = text;
		}
	} catch {}
	return notes;
}
function storeNote(key: string, text: string): void {
	try {
		if (text) localStorage.setItem(key, text);
		else localStorage.removeItem(key);
	} catch {}
}
function storedNote(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

type LocalFill = { fill: Fill; questions: ReportReceipt["questions"]; pending: boolean };
type PendingAttachment = AttachmentInput & { key: string };
type LastResult = { slot: Slot; outcome: RunOutcome; previous: Fill | null; ready: Promise<ReportReceipt> };

export function RunCockpit({ runRef }: { runRef: string }) {
	const { project, session, overlayOpen, setStatus } = useApp();
	const owner = useRef(deviceSession()).current;
	const runRead = useQueryOp({ project, op: "get", input: { refs: [runRef] } });
	const parsedRun = Run.safeParse(runRead.data?.[0]);
	const run = parsedRun.success && parsedRun.data.ref === runRef ? parsedRun.data : null;
	useEffect(() => {
		setStatus("Each result records its pinned version. p pass · f fail · b blocked · s skip.");
	}, [setStatus]);
	const slotInput: Api["find"]["input"] = { in: "slots", run: runRef, limit: 200 };
	const cacheKey = [...queryKey({ project, op: "find", input: slotInput }), "pages"];
	const slotsRead = useInfiniteQuery({
		queryKey: cacheKey,
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...slotInput, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	const parsedSlots = Slot.array().safeParse(slotsRead.data?.pages.flatMap((page) => page.items));
	const storedSlots = parsedSlots.success ? parsedSlots.data : [];
	const confirmedSlots = useRef(new Map<number, Slot>());
	for (const slot of storedSlots)
		if (slot.fills.every((fill) => fill.result > 0)) confirmedSlots.current.set(slot.id, slot);
	const [local, setLocal] = useState<Map<number, LocalFill>>(new Map());
	const [cursor, setCursor] = useState<number | null>(null);
	const stepPrefix = deviceKey("run-step", `${project}:${runRef}:`, owner.person);
	const digitSequence = useRef({ slot: 0, at: 0 });
	const consumedNotes = useRef(new Map<number, string>());
	const consumedSteps = useRef(new Map<number, string>());
	const [steps, setSteps] = useState<Record<string, string>>(() => readNotes(stepPrefix));
	const [noting, setNoting] = useState<Slot | null>(null);
	// A note belongs to its slot and is kept on this device from the first key until the server has the result:
	// a reload, a failed request, or two failed requests in a row lose none of them.
	const notePrefix = deviceKey("run-note", `${project}:${runRef}:`, owner.person);
	const [notes, setNotes] = useState<Record<string, string>>(() => readNotes(notePrefix));
	const setNoteOf = (slotId: number, text: string): void => {
		if (!sessionCurrent(owner)) return;
		consumedNotes.current.delete(slotId);
		storeNote(`${notePrefix}${slotId}`, text);
		setNotes((previous) => {
			const next = { ...previous };
			if (text) next[slotId] = text;
			else delete next[slotId];
			return next;
		});
	};
	// A note typed in another tab on this run shows here too.
	useEffect(() => {
		const changed = (event: StorageEvent): void => {
			if (event.key === null || event.key.startsWith(notePrefix)) setNotes(readNotes(notePrefix));
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, [notePrefix]);
	const pendingFiles = useRef(new Map<number, PendingAttachment[]>());
	const consumedFiles = useRef(new Set<PendingAttachment>());
	const readingFiles = useRef(new Set<number>());
	const [, refreshFiles] = useState(0);
	async function addFiles(slotId: number, files: File[]) {
		if (!sessionCurrent(owner) || files.length === 0) return;
		if (readingFiles.current.has(slotId)) {
			setStatus("Wait for this slot's files to finish reading.");
			return;
		}
		readingFiles.current.add(slotId);
		refreshFiles((value) => value + 1);
		try {
			const existing = pendingFiles.current.get(slotId) ?? [];
			if (files.some((file) => file.size > ATTACHMENT_LIMITS.file))
				throw new Error("Each attachment must be at most 4 MiB.");
			if (existing.length + files.length > ATTACHMENT_LIMITS.perResult)
				throw new Error("A result may carry at most 20 attachments.");
			const total =
				existing.reduce((sum, file) => sum + attachmentBytes(file.data), 0) +
				files.reduce((sum, file) => sum + file.size, 0);
			if (total > ATTACHMENT_LIMITS.report) throw new Error("Attachments for a result must total at most 16 MiB.");
			const added: PendingAttachment[] = [];
			for (const file of files) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 8192)
					binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
				added.push({
					...AttachmentInput.parse({ name: file.name || "screenshot.png", data: btoa(binary) }),
					key: randomId(),
				});
			}
			if (!sessionCurrent(owner)) return;
			pendingFiles.current.set(slotId, [...(pendingFiles.current.get(slotId) ?? []), ...added]);
			setStatus("Attachment added to this slot's next result. Keep this page open until you record it.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "The file could not be read.");
		} finally {
			readingFiles.current.delete(slotId);
			refreshFiles((value) => value + 1);
		}
	}
	const noteRef = useRef<HTMLInputElement>(null);
	const [last, setLast] = useState<LastResult | null>(null);
	const writes = useRef(new Map<number, Promise<ReportReceipt>>());
	const withdrawn = useRef(new Set<Promise<ReportReceipt>>());
	const latest = useRef(new Map<number, Fill>());
	/** The step each result of this page was recorded at, by the id it had when sent: the cache holds that copy until the slots are read again. */
	const recordedSteps = useRef(new Map<number, string | null>());
	const queued = useRef(new Map<number, number>());
	const method = session.kind === "agent" ? "agent" : "human";
	const slots: Slot[] = storedSlots.map((slot) => {
		const own = local.get(slot.id);
		return own?.pending
			? {
					...slot,
					state: own.fill.outcome === "pass" ? "satisfied" : own.fill.outcome === "fail" ? "failing" : "skipped",
					fills: [...slot.fills.filter((fill) => fill.by !== session.actor || fill.method !== method), own.fill],
				}
			: slot;
	});
	const missing = (slot: Slot) => slot.state === "missing" && !local.get(slot.id)?.pending;
	if (cursor === null && slots.length) setCursor((slots.find(missing) ?? slots[0])?.id ?? null);
	const current = cursor === null ? (slots.find(missing) ?? slots[0]) : slots.find((slot) => slot.id === cursor);
	const step = current ? (steps[current.id] ?? "") : "";
	function setStep(value: string | ((previous: string) => string)): void {
		if (!current || !sessionCurrent(owner)) return;
		const next = typeof value === "function" ? value(step) : value;
		consumedSteps.current.delete(current.id);
		storeNote(`${stepPrefix}${current.id}`, next);
		setSteps((prior) => ({ ...prior, [current.id]: next }));
	}
	useEffect(() => {
		const interrupt = (event: KeyboardEvent) => {
			if (!/^\d$/.test(event.key)) digitSequence.current = { slot: 0, at: 0 };
		};
		window.addEventListener("keydown", interrupt, true);
		return () => window.removeEventListener("keydown", interrupt, true);
	}, []);
	function clearStep(slotId: number, sent: string): void {
		if (storedNote(`${stepPrefix}${slotId}`) !== sent) return;
		storeNote(`${stepPrefix}${slotId}`, "");
		setSteps((prior) => {
			const next = { ...prior };
			delete next[slotId];
			return next;
		});
	}
	const next = current
		? [
				...slots.slice(slots.findIndex((slot) => slot.id === current.id) + 1),
				...slots.slice(
					0,
					slots.findIndex((slot) => slot.id === current.id),
				),
			]
				.filter(missing)
				.slice(0, 5)
		: [];
	const documents = current ? [current, ...next.filter((slot) => slot.id !== current.id)] : [];
	const external = (slot: Slot) =>
		slot.fills.length > 0 && !slot.fills.some((fill) => fill.by === session.actor && fill.method === method);
	const ownFill = current?.fills.find((fill) => fill.by === session.actor && fill.method === method);
	const note = current ? (notes[current.id] ?? "") : "";
	const currentRead = useQueryOp({
		project,
		op: "get",
		input: { refs: [current?.case ?? ""], ...(current ? { version: current.version } : {}) },
		enabled: Boolean(current),
	});
	const currentBody = RunCase.safeParse(currentRead.data?.[0]);
	const bodyMatches =
		currentBody.success && currentBody.data.ref === current?.case && currentBody.data.version === current?.version;
	const admittedMethod = Boolean(
		run?.require.some((obligation) => obligation.kind === "exercise" && obligation.methods.includes(method)) &&
			(!bodyMatches || (currentBody.success && currentBody.data.methods.includes(method))),
	);
	const canRecord = Boolean(
		current && !external(current) && run?.state === "open" && session.can.includes("produce") && admittedMethod,
	);
	const allFilled = slots.length > 0 && !slots.some(missing) && !slotsRead.hasNextPage;
	useEffect(() => {
		if (current?.id) document.querySelector(`[data-slot="${current.id}"]`)?.scrollIntoView({ block: "nearest" });
	}, [current?.id]);
	const hasMissing = slots.some(missing);
	useEffect(() => {
		if (!hasMissing && slotsRead.hasNextPage && !slotsRead.isFetchingNextPage) void slotsRead.fetchNextPage();
	}, [hasMissing, slotsRead.hasNextPage, slotsRead.isFetchingNextPage, slotsRead.fetchNextPage]);
	function move(delta: number): void {
		if (!current) return;
		const index = slots.findIndex((slot) => slot.id === current.id);
		for (let distance = 1; distance <= slots.length; distance++) {
			const candidate = slots[index + distance * delta];
			if (!candidate) return;
			if (!external(candidate)) {
				setCursor(candidate.id);
				setNoting(null);
				return;
			}
		}
	}
	function record(
		outcome: RunOutcome,
		slot = current,
		text = slot && consumedNotes.current.get(slot.id) !== notes[slot.id] ? (notes[slot.id] ?? "") : "",
		advance = true,
		visibleStep = false,
		restores: Fill | null = null,
	): Promise<ReportReceipt> | null {
		if (!slot || !sessionCurrent(owner) || !session.can.includes("produce")) return null;
		if (run?.state !== "open") {
			setStatus("This run is closed. No result was recorded; your note is kept.");
			return null;
		}
		if (readingFiles.current.has(slot.id)) {
			setStatus("Wait for this slot's attachments to finish reading before recording.");
			return null;
		}
		const files = restores
			? []
			: (pendingFiles.current.get(slot.id) ?? []).filter((file) => !consumedFiles.current.has(file));

		const slotId = slot.id;
		slot = slots.find((item) => item.id === slotId) ?? slot;
		if (external(slot)) {
			setStatus(
				"This slot is already filled by another producer. Your note is kept. j moves to the next slot for you.",
			);
			return null;
		}
		for (const file of files) consumedFiles.current.add(file);
		const previous = slot.fills.find((fill) => fill.by === session.actor && fill.method === method) ?? null;
		const fill: Fill = {
			result: -Date.now(),
			by: session.actor,
			method,
			outcome,
			admitted: "exact",
			at: Date.now(),
			note: text || null,
			atStep: outcome === "fail" ? (restores?.atStep ?? null) : null,
		};
		setLocal((value) => new Map(value).set(slot.id, { fill, pending: true, questions: [] }));
		void queryClient.cancelQueries({ queryKey: cacheKey });
		queryClient.setQueryData<InfiniteData<Api["find"]["reply"]>>(
			cacheKey,
			(value) =>
				value && {
					...value,
					pages: value.pages.map((page) => ({
						...page,
						items: page.items.map((row) =>
							row.id === slot.id
								? {
										...row,
										state: outcome === "pass" ? "satisfied" : outcome === "fail" ? "failing" : "skipped",
										fills: [...slot.fills.filter((f) => f.by !== session.actor || f.method !== method), fill],
									}
								: row,
						),
					})),
				},
		);
		const pinnedInput = { refs: [slot.case], version: slot.version };
		const marked = steps[slot.id] ?? "";
		// Undo records what was recorded before. A step marked since then is for the next failure: it is not
		// used here and it stays, as a note typed since then does.
		const failedStep =
			!restores && outcome === "fail" && (visibleStep || consumedSteps.current.get(slot.id) !== marked)
				? Number(marked)
				: 0;
		if (text && text === notes[slot.id]) consumedNotes.current.set(slot.id, text);
		if (!restores) consumedSteps.current.set(slot.id, marked);
		const priorWrite = writes.current.get(slot.id);
		const rollback = confirmedSlots.current.get(slot.id) ?? slot;
		queued.current.set(slot.id, fill.result);
		const resultInput: Api["report"]["input"]["results"][number] = {
			test: { case: slot.case },
			outcome,
			...(text ? { note: text } : {}),
		};
		const request = (async () => {
			if (priorWrite) await priorWrite.catch(() => undefined);
			if (!sessionCurrent(owner)) throw new Error("The session changed. Your note is kept.");
			const cached = RunCase.safeParse(
				queryClient.getQueryData<Api["get"]["reply"]>(queryKey({ project, op: "get", input: pinnedInput }))?.[0],
			);
			const body =
				cached.success && cached.data.ref === slot.case && cached.data.version === slot.version
					? cached.data
					: RunCase.parse((await call("get", pinnedInput, { project, owner }))[0]);
			if (body.ref !== slot.case || body.version !== slot.version)
				throw new Error("The pinned case could not be read. Try again.");
			if (!body.methods.includes(method))
				throw new Error("This pinned case does not admit your method. Its slot needs another producer.");
			const restoredStep =
				restores?.outcome === "fail" ? (restores.atStep ?? recordedSteps.current.get(restores.result) ?? null) : null;
			const atStep = failedStep > 0 ? body.steps[failedStep - 1]?.id : (restoredStep ?? undefined);
			if (failedStep > 0 && !atStep) {
				clearStep(slot.id, marked);
				throw new Error(`The pinned case has no step ${failedStep}. The mark was cleared; your note is kept`);
			}
			recordedSteps.current.set(fill.result, atStep ?? null);
			const recent = latest.current.get(slot.id);
			const corrects =
				previous && previous.result > 0 && (!recent || previous.at > recent.at)
					? previous.result
					: (recent?.result ?? previous?.result);
			const receipt = await call(
				"report",
				{
					run: runRef,
					cmd: randomId(),
					results: [
						{
							...resultInput,
							...(files.length
								? {
										attachments: files.map(({ key: _key, ...file }) => ({
											...file,
											...(atStep ? { at: atStep } : {}),
										})),
									}
								: {}),
							...(atStep ? { steps: [{ step: atStep, outcome: "fail" }] } : {}),
							...(corrects !== undefined && corrects > 0 ? { corrects } : {}),
						},
					],
				},
				{ project, owner },
			);
			if (!sessionCurrent(owner)) throw new Error("The session changed. Your note is kept.");
			if (receipt.rejected.length || receipt.declined?.length || !receipt.results[0])
				throw new Error(receipt.rejected[0]?.reason ?? receipt.declined?.[0]?.reason ?? "The result was not recorded.");
			const saved = { ...fill, result: receipt.results[0], atStep: atStep ?? null };
			latest.current.set(slot.id, saved);
			if (files.length) {
				for (const file of files) consumedFiles.current.delete(file);
				pendingFiles.current.set(
					slot.id,
					(pendingFiles.current.get(slot.id) ?? []).filter((file) => !files.includes(file)),
				);
				refreshFiles((value) => value + 1);
			}
			// The server has it: the device's copy of the note has done its work. A note typed for this slot while
			// the request was on its way is newer than what was recorded, and stays.
			if (storedNote(`${notePrefix}${slot.id}`) === text) setNoteOf(slot.id, "");
			if (!restores) clearStep(slot.id, marked);
			if (queued.current.get(slot.id) === fill.result)
				setLocal((value) => new Map(value).set(slot.id, { fill: saved, questions: receipt.questions, pending: false }));
			setStatus(
				`${slot.case} ${outcome} recorded on pinned version ${slot.version}${receipt.questions[0] ? ` · ${receipt.questions[0].q}: ${receipt.questions[0].how}` : ""}.`,
			);
			void invalidateProject(project);
			return receipt;
		})();
		writes.current.set(slot.id, request);
		void request.catch((error: unknown) => {
			if (!sessionCurrent(owner)) return;
			for (const file of files) consumedFiles.current.delete(file);
			if (consumedNotes.current.get(slot.id) === text) consumedNotes.current.delete(slot.id);
			if (consumedSteps.current.get(slot.id) === marked) consumedSteps.current.delete(slot.id);
			if (writes.current.get(slot.id) !== request) return;
			const restored = confirmedSlots.current.get(slot.id) ?? rollback;
			queryClient.setQueryData<InfiniteData<Api["find"]["reply"]>>(
				cacheKey,
				(value) =>
					value && {
						...value,
						pages: value.pages.map((page) => ({
							...page,
							items: page.items.map((row) => (row.id === slot.id ? restored : row)),
						})),
					},
			);
			setLocal((value) => {
				const next = new Map(value);
				next.delete(slot.id);
				return next;
			});
			setLast((value) => (value?.ready === request ? null : value));
			// The person may already be typing another note. Restore the slot without changing their selection or input.
			setStatus(
				`${slot.case} was not recorded: ${error instanceof Error ? error.message : "The request failed"}. Its note is kept. Return to the slot to retry.`,
			);
			void invalidateProject(project);
		});
		if (advance) {
			setCursor(next[0]?.id ?? slot.id);
			setNoting(null);
			noteRef.current?.blur();
		}
		setLast({ slot, outcome, previous, ready: request });
		return request;
	}
	function startFail(): void {
		if (!current || !canRecord) return;
		setNoting(current);
		noteRef.current?.focus();
	}
	function undo(): void {
		if (!last || withdrawn.current.has(last.ready)) return;
		setCursor(last.slot.id);
		setNoting(null);
		noteRef.current?.blur();
		const correction = record(
			last.previous?.outcome === "pass"
				? "pass"
				: last.previous?.outcome === "fail"
					? "fail"
					: last.previous?.outcome === "blocked"
						? "blocked"
						: "skip",
			last.slot,
			last.previous?.note ?? "Withdrawn by the author",
			false,
			false,
			last.previous,
		);
		if (!correction) return;
		withdrawn.current.add(last.ready);
		setLast(null);
		setStatus(
			last.previous
				? "The earlier outcome is restored by a correction."
				: "The result is corrected to skipped. A skipped slot counts as no proof.",
		);
	}
	const active = () => !overlayOpen && !noting;
	const bindings: Binding[] = [
		{
			key: "enter",
			label: "Record failure",
			allowInInput: true,
			hidden: !noting,
			when: () => !overlayOpen && Boolean(noting),
			handler: () => {
				if (noting) record("fail", noting, notes[noting.id] ?? "", true, true);
			},
		},
		{
			key: "escape",
			label: "Cancel note",
			hidden: !noting,
			when: () => !overlayOpen && Boolean(noting),
			handler: () => {
				setNoting(null);
				noteRef.current?.blur();
			},
		},
		...["escape", "backspace"].map((key) => ({
			key,
			label: "Clear step mark",
			handler: () => setStep(""),
			when: () => active() && Boolean(step),
			hidden: true,
		})),
		{ key: "j", label: "Next slot", handler: () => move(1), when: active },
		{ key: "k", label: "Previous slot", handler: () => move(-1), when: active },
		{ key: "arrowdown", label: "Next slot", handler: () => move(1), when: active, hidden: true },
		{ key: "arrowup", label: "Previous slot", handler: () => move(-1), when: active, hidden: true },
		...Array.from({ length: 10 }, (_, digit) => ({
			key: String(digit),
			label: `Mark step digit ${digit}`,
			handler: () => {
				if (!current) return;
				const previous = digitSequence.current;
				const append = previous.slot === current.id && performance.now() - previous.at < 600;
				setStep((value) => `${append ? value : ""}${digit}`.replace(/^0+/, ""));
				digitSequence.current = { slot: current.id, at: performance.now() };
			},
			when: () => active() && canRecord,
			hidden: true,
		})),
		{ key: "u", label: "Correct last result", handler: undo, when: () => active() && Boolean(last) },
		{
			key: "p",
			label: "Pass",
			hidden: !canRecord || Boolean(noting),
			handler: () => {
				record("pass");
			},
			when: () => active() && canRecord,
		},
		{
			key: "f",
			label: "Fail and note",
			hidden: !canRecord || Boolean(noting),
			handler: startFail,
			when: () => active() && canRecord,
		},
		{
			key: "b",
			label: "Blocked",
			hidden: !canRecord || Boolean(noting),
			handler: () => {
				record("blocked");
			},
			when: () => active() && canRecord,
		},
		{
			key: "s",
			label: "Skip",
			hidden: !canRecord || Boolean(noting),
			handler: () => {
				record("skip");
			},
			when: () => active() && canRecord,
		},
	];
	useBindings(bindings);
	const back = routeUrl({ project, screen: "runs" });
	return (
		<>
			<section className="pane run-pane" id="list">
				<div className="phead">
					<a
						className="dim"
						href={back}
						onClick={(event) => {
							event.preventDefault();
							navigate(back);
						}}
					>
						Runs
					</a>
					<span className="ref">{runRef}</span>
					<b className="run-title">{run?.name ?? "Run"}</b>
					<span className="dim">
						{slots.filter(missing).length}
						{slotsRead.hasNextPage ? "+" : ""} left
					</span>
				</div>
				<div className="run-summary">
					<span className={`run-verdict v-${run?.verdict ?? "pending"}`}>
						{run?.reason ?? runRead.error?.message ?? "Reading the run…"}
					</span>
					<div className="dim">{run && tallyText(run.tally)}</div>
					<div className="dim">
						{run &&
							("self" in run.accepts
								? "Only this run's results count; proves nothing about a build."
								: "build" in run.accepts
									? `Accepts results for build ${run.accepts.build}${run.accepts.env ? ` in ${run.accepts.env}` : ""}.`
									: `Accepts results for commit ${run.accepts.commit}${run.accepts.env ? ` in ${run.accepts.env}` : ""}.`)}
					</div>
				</div>
				<section className="run-strip" aria-label="Run progress">
					{slots.map((slot, index) => (
						<button
							type="button"
							key={slot.id}
							className={`run-dot state-${slot.state} method-${slot.fills.at(-1)?.method ?? "none"} ${current?.id === slot.id ? "on" : ""}`}
							aria-label={`Slot ${index + 1}: ${slot.case}, ${slot.state}${slot.fills.at(-1) ? ` by ${slot.fills.at(-1)?.by}` : ""}`}
							onClick={() => {
								setCursor(slot.id);
								setNoting(null);
							}}
						/>
					))}
				</section>
				<div className="pane-scroll" role="listbox" aria-label="Run slots">
					{slots.map((slot, index) => (
						<div key={slot.id} data-slot={slot.id}>
							<ListRow
								selected={current?.id === slot.id}
								onClick={() => {
									setCursor(slot.id);
									setNoting(null);
								}}
							>
								<span className="run-number">{String(index + 1).padStart(2, "0")}</span>
								<span className="ref">{slot.case}</span>
								<span className="run-title">{slot.title}</span>
								<span className="dim mono">v{slot.version}</span>
								<span className="run-fill">
									{slot.fills.length ? (
										slot.fills.map((fill) => (
											<span
												key={`${fill.by}:${fill.method}`}
												title={`${fill.outcome} by ${fill.by}, basis ${fill.admitted}`}
											>
												<ProducerGlyph kind={fill.method} />
												<span className={`outcome-${fill.outcome}`}>{fill.outcome}</span>
												<span className="fill-by">{fill.by}</span>
											</span>
										))
									) : (
										<span className="run-yours">{slot.assignee ?? "yours"}</span>
									)}
								</span>
								{local.get(slot.id)?.questions.map((q) => (
									<a
										key={q.q}
										className="ref run-question"
										title={q.how === "new" ? q.title : `${q.how}: ${q.answer ?? q.title}`}
										href={refUrl({ project, ref: q.q })}
										onClick={(event) => {
											event.preventDefault();
											navigate(refUrl({ project, ref: q.q }));
										}}
									>
										{q.q}
									</a>
								))}
							</ListRow>
						</div>
					))}
					{!slots.length && (
						<EmptyState>
							{slotsRead.error?.message ??
								(slotsRead.isPending
									? "Reading pinned slots…"
									: "This run has no cases. Press n in Runs to plan another.")}
						</EmptyState>
					)}
					{slotsRead.hasNextPage && (
						<button className="run-more" type="button" onClick={() => void slotsRead.fetchNextPage()}>
							More slots
						</button>
					)}
				</div>
				{next[0] && <UpNext slot={next[0]} />}
			</section>
			<section className="pane run-pane" id="detail">
				<div className="pane-scroll run-documents">
					{documents.map((slot) => (
						<RunDocument key={slot.id} slot={slot} active={current?.id === slot.id} step={step} />
					))}
					{!current && <EmptyState>Select a run slot to start.</EmptyState>}
				</div>
				<footer className="run-controls">
					{current && external(current) && (
						<div className="filled">
							{current.fills.map((fill) => (
								<span key={fill.result}>
									<ProducerGlyph kind={fill.method} /> Filled by{" "}
									{fill.method === "auto" ? "pipeline" : fill.method === "agent" ? "agent" : "person"} {fill.by} ·{" "}
									{fill.outcome} · basis {fill.admitted}
								</span>
							))}
							<span>j skips to your next slot.</span>
						</div>
					)}
					{current && currentBody.success && !admittedMethod && (
						<p className="dim">
							This slot does not admit results from your method. Pipeline or agent evidence must fill it.
						</p>
					)}
					{allFilled && <p className="dim">Nothing left for you to run. The server verdict is shown above.</p>}
					<div className="outs">
						{(
							[
								["p", "pass"],
								["f", "fail"],
								["b", "blocked"],
								["s", "skip"],
							] satisfies [string, RunOutcome][]
						).map(([key, outcome]) => (
							<button
								type="button"
								className={`out ${ownFill?.outcome === outcome || (noting && outcome === "fail") ? "on" : ""}`}
								key={key}
								disabled={!canRecord}
								onClick={() => (outcome === "fail" ? startFail() : record(outcome))}
							>
								<KeyCap>{key}</KeyCap>
								{outcomeName[outcome]}
							</button>
						))}
					</div>
					<input
						className={`run-note ${noting ? "failing" : ""}`}
						ref={noteRef}
						aria-label="Result note"
						onPaste={(event) => {
							const files = [...event.clipboardData.files];
							if (current && files.length) {
								event.preventDefault();
								void addFiles(current.id, files);
							}
						}}
						value={note}
						disabled={!canRecord && !noting && !note}
						placeholder={
							noting
								? "What did you see? Enter records the failure."
								: "Optional note. f focuses it; Enter records a failure."
						}
						onChange={(event) => {
							if (current) setNoteOf(current.id, event.target.value);
							if (!noting && current) setNoting(current);
						}}
						onKeyDown={(event) => {
							if (event.repeat && (event.key === "Enter" || event.key === "Escape")) {
								event.preventDefault();
								return;
							}
							if (event.key === "Enter" && noting) {
								event.preventDefault();
								record("fail", noting, event.currentTarget.value, true, true);
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setNoting(null);
								noteRef.current?.blur();
							}
						}}
					/>
					{current && (
						<div className="run-attachment-picker">
							<label>
								Attach a file
								<input
									type="file"
									multiple
									aria-label="Attach a file"
									disabled={!canRecord}
									onChange={(event) => {
										const files = [...(event.target.files ?? [])];
										event.target.value = "";
										void addFiles(current.id, files);
									}}
								/>
							</label>
							<span className="dim">
								Paste a screenshot into the note. 4 MiB per file, 16 MiB per result. Unrecorded files stay only on this
								page.
							</span>
							<ul>
								{(pendingFiles.current.get(current.id) ?? []).map((file) => (
									<li key={file.key}>
										{file.name}{" "}
										<button
											type="button"
											onClick={() => {
												pendingFiles.current.set(
													current.id,
													(pendingFiles.current.get(current.id) ?? []).filter((item) => item !== file),
												);
												refreshFiles((value) => value + 1);
											}}
										>
											Remove {file.name}
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					<div className="run-control-hint">
						{step ? `Step ${step} marked. ` : ""}
						<KeyCap>2</KeyCap> <KeyCap>f</KeyCap> fails step 2.{" "}
						{ownFill && "Recording again corrects your earlier result."}
					</div>
					<div className="run-last" role="status">
						{last
							? `${last.slot.case} · ${outcomeName[last.outcome]} on pinned v${last.slot.version}`
							: "Each result records the pinned case version."}
						{last && (
							<button type="button" onClick={undo}>
								<KeyCap>u</KeyCap> correct
							</button>
						)}
					</div>
				</footer>
			</section>
		</>
	);
}

function RunDocument({ slot, active, step }: { slot: Slot; active: boolean; step: string }) {
	const { project } = useApp();
	const read = useQueryOp({ project, op: "get", input: { refs: [slot.case], version: slot.version } });
	const checked = RunCase.safeParse(read.data?.[0]);
	const parsed =
		checked.success && checked.data.ref === slot.case && checked.data.version === slot.version
			? checked
			: ({ success: false } satisfies { success: boolean });
	return (
		<article
			hidden={!active}
			data-run-document={slot.case}
			data-active={active}
			data-ready={parsed.success}
			className="run-document"
		>
			<div className="run-document-meta">
				<span className="ref">{slot.case}</span>
				<span>v{slot.version}, pinned when the run started</span>
				{slot.head !== slot.version && <span className="dim">Current case is v{slot.head}</span>}
			</div>
			<h2>{parsed.success ? parsed.data.title : slot.title}</h2>
			{parsed.success ? (
				<>
					{parsed.data.pre && <p className="run-pre">{parsed.data.pre}</p>}
					<ol className="rsteps">
						{parsed.data.steps.map((entry, index) => (
							<li key={entry.id} className={Number(step) === index + 1 ? "mark" : ""} data-step={entry.id}>
								<span className="sn">{index + 1}</span>
								<div>
									{entry.action}
									{entry.source && (
										<div className="dim">
											From {entry.source.fragment} v{entry.source.version}
										</div>
									)}
									{entry.expected && <div className="rx">&gt; {entry.expected}</div>}
								</div>
							</li>
						))}
					</ol>
					{!parsed.data.steps.length && <p className="dim">This pinned case has no steps.</p>}
				</>
			) : (
				<p className="dim" role="status">
					{read.error?.message ?? "Reading the pinned case…"}
				</p>
			)}
			{slot.fills.map((fill) => (
				<div className="run-evidence" key={fill.result}>
					<ProducerGlyph kind={fill.method} /> {fill.outcome} by {fill.by} · basis {fill.admitted} · {age(fill.at)}
					{fill.note && <p>{fill.note}</p>}
					<ResultAttachments result={fill.result} />
				</div>
			))}
		</article>
	);
}
function UpNext({ slot }: { slot: Slot }) {
	const { project } = useApp();
	const read = useQueryOp({ project, op: "get", input: { refs: [slot.case], version: slot.version } });
	const checked = RunCase.safeParse(read.data?.[0]);
	const parsed =
		checked.success && checked.data.ref === slot.case && checked.data.version === slot.version
			? checked
			: ({ success: false } satisfies { success: boolean });
	return (
		<aside className="run-up-next" aria-label="Up next">
			<div className="sech">
				Up next <span className="ref">{slot.case}</span>
				<span className="dim">pinned v{slot.version}</span>
			</div>
			<b>{parsed.success ? parsed.data.title : slot.title}</b>
			{parsed.success && (
				<ol>
					{parsed.data.steps.slice(0, 2).map((step) => (
						<li key={step.id}>
							{step.action}
							{step.expected && <span className="rx"> &gt; {step.expected}</span>}
						</li>
					))}
				</ol>
			)}
		</aside>
	);
}
