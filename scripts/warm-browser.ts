// CI, before the tests: start the browser once and close it. On GitHub's runner the first browser test of a job
// took 12 s in one run and over 30 s (a time-out) in another, and the tests after it 2 s. The first launch of
// Chrome on a cold runner is the likely cause and is not established: this is a guess until a pushed run shows
// the first test at the speed of the rest. A failure here is not the job's: the tests say what is wrong.
import { browserAvailable, launchBrowser } from "../test/e2e/support.ts";

const started = performance.now();
if (browserAvailable) {
	const browser = await launchBrowser();
	const page = await browser.newPage();
	await page.goto("about:blank");
	await browser.close();
}
console.log(
	`browser ${browserAvailable ? "started and closed" : "missing"}: ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
