// What an event of the change stream does to what the page has read (`changed`, `invalidateProject`). The
// reads are the real query client's; the server is a function this test answers by hand.
import { afterEach, expect, test } from "bun:test";
import { InfiniteQueryObserver, notifyManager, QueryObserver } from "@tanstack/react-query";
import { changed, invalidateProject, queryClient, queryKey } from "./data.ts";
import { undoChange } from "./rollback.ts";

afterEach(() => {
	queryClient.clear();
});

/** Waits for the query client's observable result, including its deferred notifications. */
async function until(check: () => void): Promise<void> {
	const end = Date.now() + 2000;
	for (;;) {
		try {
			check();
			return;
		} catch (error) {
			if (Date.now() >= end) throw error;
		}
		await Bun.sleep(1);
	}
}

/** A read of `Q-3` that the test answers when it chooses, as a screen holds it. */
function question() {
	const replies: ((state: string) => void)[] = [];
	const observer = new QueryObserver<{ state: string }[]>(queryClient, {
		queryKey: queryKey({ project: "scratch", op: "get", input: { refs: ["Q-3"] } }),
		queryFn: () => new Promise((resolve) => replies.push((state) => resolve([{ state }]))),
	});
	const stop = observer.subscribe(() => {});
	const answer = async (index: number, state: string): Promise<void> => {
		replies[index]?.(state);
		await until(() => expect(observer.getCurrentResult().data?.[0]?.state).toBe(state));
	};
	return { replies, answer, stop, shown: () => observer.getCurrentResult().data?.[0]?.state };
}

// Issue #87: the queue first asked for a question 10 ms before it was settled elsewhere. The reply was read
// before the settlement and arrived after its event, and the page took it as the question's state.
for (const [name, tell] of [
	["an event that names the question", () => changed("scratch", { op: "decide", touched: ["Q-3"] })],
	["a stream that opens again", () => void invalidateProject("scratch")],
] as const)
	test(`a first read still on its way when a change is told is asked again when it lands: ${name}`, async () => {
		const read = question();
		try {
			expect(read.replies).toHaveLength(1);
			tell();
			// The read that is on its way is not thrown away: until it lands the screen has nothing to show.
			expect(read.replies).toHaveLength(1);
			await read.answer(0, "open");
			await until(() => expect(read.replies).toHaveLength(2));
			await read.answer(1, "decided");
			expect(read.shown()).toBe("decided");
			await until(() => expect(read.replies).toHaveLength(2));
		} finally {
			read.stop();
		}
	});

test("a first read is asked again once, however many changes are told while it is on its way", async () => {
	const read = question();
	try {
		for (let i = 0; i < 5; i++) changed("scratch", { op: "decide", touched: ["Q-3"] });
		await read.answer(0, "open");
		await until(() => expect(read.replies).toHaveLength(2));
		await read.answer(1, "decided");
		expect(read.shown()).toBe("decided");
		await until(() => expect(read.replies).toHaveLength(2));
	} finally {
		read.stop();
	}
});

test("a read that has landed is asked again at once, and a change to something else asks nothing", async () => {
	const read = question();
	try {
		await read.answer(0, "open");
		changed("scratch", { op: "decide", touched: ["Q-9"] });
		changed("other", { op: "decide", touched: ["Q-3"] });
		expect(read.replies).toHaveLength(1);
		changed("scratch", { op: "decide", touched: ["Q-3"] });
		await until(() => expect(read.replies).toHaveLength(2));
		await read.answer(1, "decided");
		expect(read.shown()).toBe("decided");
	} finally {
		read.stop();
	}
});

for (const [screen, key] of [
	["Suite", ["scratch", "find", { in: "cases", limit: 500 }, "pages"]],
	["Queue", ["scratch", "inbox", { state: "open", limit: 100 }, "pages"]],
	["Runs", ["scratch", "find", { in: "runs", limit: 100 }, "pages"]],
	["run slots", ["scratch", "find", { in: "slots", run: "R-1", limit: 200 }, "pages"]],
] as const) {
	test(`${screen}: changes during first reads, paging and refreshes coalesce without cancelling progress`, async () => {
		type Page = { value: string; next: number | undefined };
		const requests: { page: number; signal: AbortSignal; reply: (value: Page) => void }[] = [];
		const observer = new InfiniteQueryObserver(queryClient, {
			queryKey: key,
			initialPageParam: 0,
			queryFn: ({ pageParam, signal }) =>
				new Promise<Page>((reply) => requests.push({ page: pageParam, signal, reply })),
			getNextPageParam: (page) => page.next,
		});
		const stop = observer.subscribe(() => {});
		const tell = () => {
			for (let i = 0; i < 5; i++) {
				if (i % 2 === 0) changed("scratch", { op: "report", touched: [] });
				else void invalidateProject("scratch");
			}
		};
		const answer = (index: number, value: string, next: number | undefined) => {
			const request = requests[index];
			if (!request) throw new Error(`Missing request ${index}`);
			request.reply({ value, next });
		};
		const shown = () => observer.getCurrentResult().data?.pages.map((page) => page.value);
		try {
			tell();
			answer(0, "first, old", 1);
			await until(() => expect(requests).toHaveLength(2));
			answer(1, "first, current", 1);
			await until(() => expect(shown()).toEqual(["first, current"]));
			expect(requests).toHaveLength(2);

			void observer.fetchNextPage();
			tell();
			expect(requests[2]?.signal.aborted).toBe(false);
			expect(requests).toHaveLength(3);
			answer(2, "second, old", undefined);
			await until(() => expect(shown()).toEqual(["first, current", "second, old"]));
			await until(() => expect(requests).toHaveLength(4));
			expect(requests[3]?.page).toBe(0);
			answer(3, "first, refreshed", 1);
			await until(() => expect(requests).toHaveLength(5));
			tell();
			expect(requests[4]?.signal.aborted).toBe(false);
			expect(requests).toHaveLength(5);
			answer(4, "second, refreshed", undefined);
			await until(() => expect(shown()).toEqual(["first, refreshed", "second, refreshed"]));
			await until(() => expect(requests).toHaveLength(6));
			answer(5, "first, latest", 1);
			await until(() => expect(requests).toHaveLength(7));
			answer(6, "second, latest", undefined);
			await until(() => expect(shown()).toEqual(["first, latest", "second, latest"]));
			expect(requests).toHaveLength(7);
		} finally {
			stop();
		}
	});
}

test("automatic paging finishes before its one pending refresh starts", async () => {
	type Page = { value: string; next: number | undefined };
	const requests: { page: number; reply: (value: Page) => void }[] = [];
	const observer = new InfiniteQueryObserver(queryClient, {
		queryKey: ["scratch", "find", { in: "cases", limit: 500 }, "pages"],
		initialPageParam: 0,
		queryFn: ({ pageParam }) => new Promise<Page>((reply) => requests.push({ page: pageParam, reply })),
		getNextPageParam: (page) => page.next,
	});
	const stop = observer.subscribe(
		notifyManager.batchCalls((read) => {
			if (read.hasNextPage && !read.isFetching) void observer.fetchNextPage();
		}),
	);
	try {
		for (let page = 0; page < 3; page++) {
			expect(requests[page]?.page).toBe(page);
			for (let event = 0; event < 5; event++) changed("scratch", { op: "propose", touched: [] });
			requests[page]?.reply({ value: `page ${page}`, next: page < 2 ? page + 1 : undefined });
			await until(() => expect(requests).toHaveLength(page + 2));
		}
		expect(observer.getCurrentResult().data?.pages.map((page) => page.value)).toEqual(["page 0", "page 1", "page 2"]);
		expect(requests.map((request) => request.page)).toEqual([0, 1, 2, 0]);
		for (let page = 0; page < 3; page++) {
			requests[page + 3]?.reply({ value: `fresh ${page}`, next: page < 2 ? page + 1 : undefined });
			if (page < 2) await until(() => expect(requests).toHaveLength(page + 5));
			else await until(() => expect(observer.getCurrentResult().isFetching).toBe(false));
		}
		expect(observer.getCurrentResult().data?.pages.map((page) => page.value)).toEqual([
			"fresh 0",
			"fresh 1",
			"fresh 2",
		]);
		expect(requests.map((request) => request.page)).toEqual([0, 1, 2, 0, 1, 2]);
	} finally {
		stop();
	}
});

test("cancelling a page for an optimistic update preserves its pending refresh", async () => {
	type Page = { value: string };
	const key = ["scratch", "find", { in: "cases", limit: 500 }, "pages"];
	const requests: { signal: AbortSignal; reply: (page: Page) => void }[] = [];
	const observer = new InfiniteQueryObserver(queryClient, {
		queryKey: key,
		initialPageParam: "",
		queryFn: ({ signal }) => new Promise<Page>((reply) => requests.push({ signal, reply })),
		getNextPageParam: () => undefined,
	});
	const stop = observer.subscribe(() => {});
	try {
		requests[0]?.reply({ value: "old" });
		await until(() => expect(observer.getCurrentResult().isFetching).toBe(false));
		void observer.refetch();
		changed("scratch", { op: "propose", touched: [] });
		void queryClient.cancelQueries({ queryKey: key });
		queryClient.setQueryData(key, { pages: [{ value: "optimistic" }], pageParams: [""] });
		requests[1]?.reply({ value: "old" });
		await until(() => expect(requests).toHaveLength(3));
		expect(requests[1]?.signal.aborted).toBe(true);
		expect(observer.getCurrentResult().data?.pages[0]?.value).toBe("optimistic");
		expect(requests).toHaveLength(3);
		for (let event = 0; event < 5; event++) changed("scratch", { op: "propose", touched: [] });
		expect(requests[2]?.signal.aborted).toBe(false);
		requests[2]?.reply({ value: "saved" });
		await until(() => expect(observer.getCurrentResult().data?.pages[0]?.value).toBe("saved"));
		await until(() => expect(requests).toHaveLength(4));
		expect(requests).toHaveLength(4);
		requests[3]?.reply({ value: "latest" });
		await until(() => expect(observer.getCurrentResult().data?.pages[0]?.value).toBe("latest"));
		expect(requests).toHaveLength(4);
	} finally {
		stop();
	}
});

test("invalidateProject waits for the coalesced refresh before an answer handler resumes", async () => {
	const replies: ((value: { state: string }) => void)[] = [];
	const observer = new InfiniteQueryObserver(queryClient, {
		queryKey: ["scratch", "inbox", { state: "open", limit: 100 }, "pages"],
		initialPageParam: "",
		queryFn: () => new Promise<{ state: string }>((reply) => replies.push(reply)),
		getNextPageParam: () => undefined,
	});
	const stop = observer.subscribe(() => {});
	try {
		replies[0]?.({ state: "open" });
		await until(() => expect(observer.getCurrentResult().isFetching).toBe(false));
		void observer.refetch();
		let resumed = false;
		const refreshed = invalidateProject("scratch").then(() => {
			resumed = true;
		});
		expect(replies).toHaveLength(2);
		expect(resumed).toBe(false);
		replies[1]?.({ state: "open" });
		await until(() => expect(replies).toHaveLength(3));
		expect(resumed).toBe(false);
		replies[2]?.({ state: "decided" });
		await refreshed;
		expect(resumed).toBe(true);
		expect(observer.getCurrentResult().data?.pages[0]?.state).toBe("decided");
	} finally {
		stop();
	}
});

test("taking back a change undoes only what it did to the row as it is now (issue #383)", () => {
	const before = { ref: "C-1", tags: [], folder: 1, state: "active" };
	const after = { ref: "C-1", tags: ["alpha"], folder: 2, state: "active" };
	// The stream showed another client's tag and move in the meantime: only the tag this change added goes.
	expect(undoChange({ ref: "C-1", tags: ["beta"], folder: 3, state: "active" }, before, after)).toEqual({
		ref: "C-1",
		tags: ["beta"],
		folder: 3,
		state: "active",
	});
	expect(undoChange({ ref: "C-1", tags: ["alpha", "beta"], folder: 2, state: "active" }, before, after)).toEqual({
		ref: "C-1",
		tags: ["beta"],
		folder: 1,
		state: "active",
	});
	// A tag the change removed comes back only if it is gone, and is not doubled.
	expect(undoChange({ tags: ["x"] }, { tags: ["x", "y"] }, { tags: ["x"] })).toEqual({ tags: ["x", "y"] });
	expect(undoChange({ tags: ["x", "y"] }, { tags: ["x", "y"] }, { tags: ["x"] })).toEqual({ tags: ["x", "y"] });
});

// The second verification of #461: a report read only its kind and window, so no ref of an event matched it, and
// Reports showed the numbers from before a report arrived until the page was loaded again.
test("a report is read again on any change to its project, whatever the change names", async () => {
	let reads = 0;
	const observer = new QueryObserver(queryClient, {
		queryKey: queryKey({ project: "scratch", op: "stats", input: { of: "reruns", days: 30 } }),
		queryFn: async () => ({ read: ++reads }),
	});
	const stop = observer.subscribe(() => {});
	try {
		await until(() => expect(reads).toBe(1));
		changed("other", { op: "report", touched: ["R-1"] });
		expect(reads).toBe(1);
		for (const [op, touched] of [
			["report", ["R-1", "T-2"]],
			["decide", ["Q-9"]],
			["propose", ["C-4"]],
		] as const) {
			const before = reads;
			changed("scratch", { op, touched: [...touched] });
			await until(() => expect(reads).toBe(before + 1));
		}
	} finally {
		stop();
	}
});
