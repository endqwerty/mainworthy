// What an event of the change stream does to what the page has read (`changed`, `invalidateProject`). The
// reads are the real query client's; the server is a function this test answers by hand.
import { afterEach, expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
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
