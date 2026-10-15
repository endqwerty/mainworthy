// What an event of the change stream does to what the page has read (`changed`, `invalidateProject`). The
// reads are the real query client's; the server is a function this test answers by hand.
import { afterEach, expect, test } from "bun:test";
import { InfiniteQueryObserver, notifyManager, QueryObserver } from "@tanstack/react-query";
import { changed, invalidateProject, queryClient, queryKey } from "./data.ts";

afterEach(() => {
	queryClient.clear();
});

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
		// The reply reaches the query, and whatever it starts is started, a few turns later.
		await Bun.sleep(5);
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
			expect(read.replies).toHaveLength(2);
			await read.answer(1, "decided");
			expect(read.shown()).toBe("decided");
			expect(read.replies).toHaveLength(2);
		} finally {
			read.stop();
		}
	});

test("a first read is asked again once, however many changes are told while it is on its way", async () => {
	const read = question();
	try {
		for (let i = 0; i < 5; i++) changed("scratch", { op: "decide", touched: ["Q-3"] });
		await read.answer(0, "open");
		expect(read.replies).toHaveLength(2);
		await read.answer(1, "decided");
		expect(read.shown()).toBe("decided");
		expect(read.replies).toHaveLength(2);
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
		await Bun.sleep(5);
		expect(read.replies).toHaveLength(1);
		changed("scratch", { op: "decide", touched: ["Q-3"] });
		await Bun.sleep(5);
		expect(read.replies).toHaveLength(2);
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
		const answer = async (index: number, value: string, next: number | undefined) => {
			const request = requests[index];
			if (!request) throw new Error(`Missing request ${index}`);
			request.reply({ value, next });
			await Bun.sleep(5);
		};
		const shown = () => observer.getCurrentResult().data?.pages.map((page) => page.value);
		try {
			tell();
			await answer(0, "first, old", 1);
			await answer(1, "first, current", 1);
			expect(shown()).toEqual(["first, current"]);
			expect(requests).toHaveLength(2);

			void observer.fetchNextPage();
			tell();
			expect(requests[2]?.signal.aborted).toBe(false);
			expect(requests).toHaveLength(3);
			await answer(2, "second, old", undefined);
			expect(shown()).toEqual(["first, current", "second, old"]);
			expect(requests[3]?.page).toBe(0);
			await answer(3, "first, refreshed", 1);
			tell();
			expect(requests[4]?.signal.aborted).toBe(false);
			expect(requests).toHaveLength(5);
			await answer(4, "second, refreshed", undefined);
			expect(shown()).toEqual(["first, refreshed", "second, refreshed"]);
			await answer(5, "first, latest", 1);
			await answer(6, "second, latest", undefined);
			expect(shown()).toEqual(["first, latest", "second, latest"]);
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
			await Bun.sleep(10);
		}
		expect(observer.getCurrentResult().data?.pages.map((page) => page.value)).toEqual(["page 0", "page 1", "page 2"]);
		expect(requests.map((request) => request.page)).toEqual([0, 1, 2, 0]);
		for (let page = 0; page < 3; page++) {
			requests[page + 3]?.reply({ value: `fresh ${page}`, next: page < 2 ? page + 1 : undefined });
			await Bun.sleep(5);
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
		await Bun.sleep(5);
		void observer.refetch();
		let resumed = false;
		const refreshed = invalidateProject("scratch").then(() => {
			resumed = true;
		});
		await Bun.sleep(5);
		expect(resumed).toBe(false);
		replies[1]?.({ state: "open" });
		await Bun.sleep(5);
		expect(resumed).toBe(false);
		replies[2]?.({ state: "decided" });
		await refreshed;
		expect(resumed).toBe(true);
		expect(observer.getCurrentResult().data?.pages[0]?.state).toBe("decided");
	} finally {
		stop();
	}
});
