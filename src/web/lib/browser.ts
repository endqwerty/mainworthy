// A short name for a browser, read from what it calls itself (`User-Agent`). It names a session in "Your
// sessions", where the text is what the server recorded at sign-in, and it is the label a new passkey starts
// with, where the text is this browser's own. Nothing checks the text: a client writes what it likes there.

const BROWSERS: readonly [RegExp, string][] = [
	// The order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
	[/\bEdg(?:e|A|iOS)?\//, "Edge"],
	[/\bOPR\//, "Opera"],
	[/\bFirefox\/|\bFxiOS\//, "Firefox"],
	[/\b(?:Headless)?Chrome\/|\bCriOS\//, "Chrome"],
	[/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: readonly [RegExp, string][] = [
	// Android says Linux too, and an iPhone says "like Mac OS X".
	[/\bAndroid\b/, "Android"],
	[/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
	[/\bWindows\b/, "Windows"],
	[/\bCrOS\b/, "ChromeOS"],
	[/\bMac OS X\b|\bMacintosh\b/, "macOS"],
	[/\bLinux\b/, "Linux"],
];
const LONGEST = 60;

/** "Chrome on Linux". Text that names no browser is shown as it is, cut short; none at all is said to be unknown. */
export function browserName(userAgent: string | null): string {
	const text = userAgent?.trim() ?? "";
	if (!text) return "Unknown browser";
	const browser = BROWSERS.find(([pattern]) => pattern.test(text))?.[1];
	const system = SYSTEMS.find(([pattern]) => pattern.test(text))?.[1];
	if (browser) return system ? `${browser} on ${system}` : browser;
	const characters = [...text];
	return characters.length > LONGEST ? `${characters.slice(0, LONGEST).join("")}…` : text;
}
