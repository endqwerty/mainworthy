import { expect, test } from "bun:test";
import { browserName } from "./browser.ts";

test("a browser is named by what it calls itself: the browser and what it runs on", () => {
	const cases: [string, string][] = [
		[
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
			"Chrome on Linux",
		],
		[
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
			"Chrome on Linux",
		],
		[
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
			"Edge on Windows",
		],
		[
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
			"Safari on macOS",
		],
		["Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox on Linux"],
		[
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
			"Safari on iOS",
		],
		[
			"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
			"Chrome on Android",
		],
	];
	for (const [userAgent, name] of cases) expect(browserName(userAgent)).toBe(name);
});

test("what is not a browser's name is shown as it was recorded, cut short, and nothing as unknown", () => {
	expect(browserName("curl/8.14.1")).toBe("curl/8.14.1");
	expect(browserName("x".repeat(200))).toBe(`${"x".repeat(60)}…`);
	expect(browserName(null)).toBe("Unknown browser");
	expect(browserName("")).toBe("Unknown browser");
});
