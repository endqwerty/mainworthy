// Everything done to the iOS app from the command line. `ios/README.md` says when to use which.
//
//   bun scripts/ios.ts gen                    write the Swift that is made from this repository's TypeScript
//   bun scripts/ios.ts serve                  start a Mainworthy for the app's tests and print how to sign in
//   bun scripts/ios.ts test [filter]          the package's tests on this Mac, against a Mainworthy started for them
//   bun scripts/ios.ts project                write ios/Mainworthy.xcodeproj
//   bun scripts/ios.ts build                  build the app for a simulator
//   bun scripts/ios.ts uitest [filter]        the app in a simulator, driven through its screens
//   bun scripts/ios.ts install [--dry-run]    build, sign and install on the iPhone that is connected
//
// What is built goes to ~/.cache/mainworthy-ios, never into the repository: a test here reads every file in it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { testInstance } from "./ios/instance.ts";
import { generated } from "./ios/swift.ts";

const ROOT = join(import.meta.dir, "..");
const IOS = join(ROOT, "ios");
const KIT = join(IOS, "Kit");
const PROJECT = join(IOS, "Mainworthy.xcodeproj");
const LOCAL = join(IOS, "Config", "Local.xcconfig");
/** Where builds go. One directory for each checkout, so two of them do not build over each other. */
const CACHE = join(homedir(), ".cache", "mainworthy-ios", Bun.hash(ROOT).toString(16));
/** The simulator the screens are tested in. It is this project's own, so no other project's test finds it busy. */
const SIMULATOR = "Mainworthy";
/** The port whose holder has the simulator (`alone`). */
const SIMULATOR_TURN = 47357;
/** How long a run waits for its turn. Every test class together takes about five minutes. */
const SIMULATOR_WAIT_MS = 30 * 60_000;

class Stop extends Error {}
const stop = (message: string): never => {
	throw new Stop(message);
};

/** `printed` is what the tool wrote as its answer; `output` is that and what it said beside it. */
type Ran = { status: number; printed: string; output: string };
/**
 * Runs a tool. It does not hold this process up while the tool runs: the server the tests talk to is in this
 * process. With `quiet`, what the tool prints is kept and not shown.
 */
async function ran(
	tool: string,
	args: string[],
	options: { env?: Record<string, string>; quiet?: boolean } = {},
): Promise<Ran> {
	try {
		const child = Bun.spawn([tool, ...args], {
			cwd: ROOT,
			env: { ...process.env, ...options.env },
			stdin: "inherit",
			stdout: options.quiet ? "pipe" : "inherit",
			stderr: options.quiet ? "pipe" : "inherit",
		});
		// Stopping this command stops the tool with it: a test run that outlived the command would still hold
		// the simulator, and nothing would say so.
		const stopTool = (): void => child.kill();
		process.once("SIGINT", stopTool);
		process.once("SIGTERM", stopTool);
		const [printed = "", said = ""] = await Promise.all(
			[child.stdout, child.stderr].map((stream) =>
				stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve(""),
			),
		);
		const status = await child.exited;
		process.off("SIGINT", stopTool);
		process.off("SIGTERM", stopTool);
		return { status, printed, output: printed + said };
	} catch (error) {
		return stop(`${tool} did not start: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Runs a tool that must succeed, and passes on what it prints. */
async function run(tool: string, args: string[], env: Record<string, string> = {}): Promise<void> {
	const { status } = await ran(tool, args, { env });
	if (status !== 0) stop(`${tool} ${args[0] ?? ""} failed (exit ${status})`);
}
/** What a tool prints, or null when it is missing or fails. */
async function read(tool: string, args: string[]): Promise<string | null> {
	try {
		const done = await ran(tool, args, { quiet: true });
		return done.status === 0 ? done.printed.trim() : null;
	} catch {
		return null;
	}
}

async function needMac(): Promise<void> {
	if (process.platform !== "darwin") stop("this needs a Mac with Xcode: the app is built with Apple's tools");
	if ((await read("xcode-select", ["-p"])) === null) stop("Xcode is not installed, or `xcode-select` names none");
}

/** The commit the app is built from, for its About screen. */
const commit = async (): Promise<string> => (await read("git", ["rev-parse", "--short", "HEAD"])) ?? "unknown";

function gen(): void {
	for (const [path, content] of Object.entries(generated())) {
		const file = join(ROOT, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
		console.log(`wrote ${path}`);
	}
}

async function serve(): Promise<void> {
	const server = await testInstance();
	console.log(`Mainworthy for the iOS tests · ${server.url}`);
	console.log(`sign in as ${server.person.name} with the password "${server.person.password}"`);
	console.log(`or as the owner, ${server.owner.name}, with the password "${server.owner.password}"`);
	console.log(`POST /test/project with the token ${server.token} makes a filled project. Ctrl-C stops it.`);
	await new Promise<void>((resolve) => process.once("SIGINT", resolve));
	await server.stop();
}

/** The package's tests. They build and run on this Mac, with no simulator, against a server started here. */
async function test(filter: string | undefined): Promise<void> {
	await needMac();
	const server = await testInstance();
	try {
		await run(
			"swift",
			["test", "--package-path", KIT, "--scratch-path", join(CACHE, "kit"), ...(filter ? ["--filter", filter] : [])],
			{
				MAINWORTHY_TEST_URL: server.url,
				MAINWORTHY_TEST_TOKEN: server.token,
				MAINWORTHY_TEST_NAME: server.person.name,
				MAINWORTHY_TEST_PASSWORD: server.person.password,
				MAINWORTHY_TEST_OWNER_NAME: server.owner.name,
				MAINWORTHY_TEST_OWNER_PASSWORD: server.owner.password,
			},
		);
	} finally {
		await server.stop();
	}
}

/** Writes the Xcode project from `ios/project.yml`. The project is not committed: this is how it comes to be. */
async function project(): Promise<void> {
	await needMac();
	if ((await read("xcodegen", ["--version"])) === null) stop("XcodeGen is missing: brew install xcodegen");
	const made = await ran("xcodegen", ["generate", "--spec", join(IOS, "project.yml"), "--project", IOS], {
		quiet: true,
	});
	if (made.status !== 0) stop(`xcodegen failed:\n${made.output}`);
}

const Simulators = z.object({
	devices: z.record(z.string(), z.array(z.object({ name: z.string(), udid: z.string(), isAvailable: z.boolean() }))),
});
const SimulatorTypes = z.object({ devicetypes: z.array(z.object({ name: z.string(), identifier: z.string() })) });
/** The id of this project's simulator, made the first time: the newest iPhone the installed Xcode has. */
async function simulator(): Promise<string> {
	const listed = Simulators.parse(JSON.parse((await read("xcrun", ["simctl", "list", "devices", "--json"])) ?? "{}"));
	const mine = Object.values(listed.devices)
		.flat()
		.find((device) => device.name === SIMULATOR && device.isAvailable);
	if (mine) return mine.udid;
	const types = SimulatorTypes.parse(
		JSON.parse((await read("xcrun", ["simctl", "list", "devicetypes", "--json"])) ?? "{}"),
	);
	const newest = types.devicetypes.filter((type) => /^iPhone \d+ Pro$/.test(type.name)).at(-1);
	if (!newest) return stop("Xcode has no iPhone simulator: install an iOS simulator in Xcode, Settings, Components");
	const made = await read("xcrun", ["simctl", "create", SIMULATOR, newest.identifier]);
	return made ?? stop("the simulator could not be made: xcrun simctl create failed");
}

/**
 * Runs xcodebuild and shows what matters of what it prints: the tests, the errors and the result. The whole of
 * it is kept in a file, which is named when the build fails.
 */
async function xcodebuild(args: string[], env: Record<string, string> = {}): Promise<void> {
	const log = join(CACHE, "xcodebuild.log");
	mkdirSync(CACHE, { recursive: true });
	const built = [...args, "-project", PROJECT, "-scheme", "Mainworthy", `MAINWORTHY_COMMIT=${await commit()}`];
	const done = await ran("xcodebuild", built, {
		env,
		quiet: true,
	});
	writeFileSync(log, done.output);
	const shown = done.output
		.split("\n")
		.filter((line) => /error: |Test Case .* (passed|failed)|: error|\*\* [A-Z ]+ \*\*|Executed \d+ tests?,/.test(line));
	console.log([...new Set(shown)].join("\n"));
	if (done.status !== 0) stop(`xcodebuild failed (exit ${done.status}); all it printed is in ${log}`);
}

/** Builds the app for a simulator and runs nothing: whether the screens still compile. */
async function build(): Promise<void> {
	await project();
	await xcodebuild([
		"build",
		"-destination",
		"generic/platform=iOS Simulator",
		"-derivedDataPath",
		join(CACHE, "simulator"),
		"CODE_SIGNING_ALLOWED=NO",
	]);
}

/**
 * Runs one thing at a time on this machine, whichever checkout asks: there is one simulator. A second caller
 * waits for the first. What is held is a port on this machine's own address. The system gives a port to one
 * process and takes it back when that process ends, however it ends, so there is nothing to find stale.
 */
async function alone<T>(work: () => Promise<T>): Promise<T> {
	let held: { stop: (closeActiveConnections?: boolean) => void } | null = null;
	const patience = Date.now() + SIMULATOR_WAIT_MS;
	let said = false;
	while (!held) {
		try {
			held = Bun.listen({ hostname: "127.0.0.1", port: SIMULATOR_TURN, socket: { data() {} } });
		} catch {
			// A port that something else took looks the same as another run's turn, so the wait has an end.
			if (Date.now() > patience)
				return stop(
					`the simulator's turn did not come in ${SIMULATOR_WAIT_MS / 60_000} minutes: \`lsof -nP -iTCP:${SIMULATOR_TURN}\` says who holds port ${SIMULATOR_TURN}`,
				);
			if (!said) console.log(`another run holds the simulator (port ${SIMULATOR_TURN}); waiting for it`);
			said = true;
			await Bun.sleep(2000);
		}
	}
	try {
		return await work();
	} finally {
		held.stop(true);
	}
}

/**
 * The app in a simulator, driven through its screens against a server started here. A test's screenshots are
 * written to the directory this prints.
 */
async function uitest(filter: string | undefined): Promise<void> {
	await project();
	const device = await simulator();
	const shots = join(CACHE, "screenshots");
	rmSync(shots, { recursive: true, force: true });
	mkdirSync(shots, { recursive: true });
	const server = await testInstance();
	try {
		await alone(() =>
			xcodebuild(
				[
					"test",
					"-destination",
					`platform=iOS Simulator,id=${device}`,
					"-derivedDataPath",
					join(CACHE, "simulator"),
					"CODE_SIGNING_ALLOWED=NO",
					// After a failed test xcodebuild otherwise spends up to ten minutes gathering the simulator's logs.
					"-collect-test-diagnostics",
					"never",
					...(filter ? [`-only-testing:MainworthyUITests/${filter}`] : []),
				],
				{
					// xcodebuild hands a variable named TEST_RUNNER_X to the tests as X.
					TEST_RUNNER_MAINWORTHY_TEST_URL: server.url,
					TEST_RUNNER_MAINWORTHY_TEST_TOKEN: server.token,
					TEST_RUNNER_MAINWORTHY_TEST_NAME: server.person.name,
					TEST_RUNNER_MAINWORTHY_TEST_PASSWORD: server.person.password,
					TEST_RUNNER_MAINWORTHY_TEST_OWNER_NAME: server.owner.name,
					TEST_RUNNER_MAINWORTHY_TEST_OWNER_PASSWORD: server.owner.password,
					TEST_RUNNER_MAINWORTHY_SCREENSHOTS: shots,
				},
			),
		);
	} finally {
		await server.stop();
	}
	console.log(`screenshots: ${shots}`);
}

/**
 * The team a development certificate on this Mac belongs to: the one thing signing needs that is a person's
 * own. It is read from the certificate and written to a file that is not committed.
 */
async function team(): Promise<string> {
	const identities = (await read("security", ["find-identity", "-v", "-p", "codesigning"])) ?? "";
	const name = /"(Apple Development: [^"]+)"/.exec(identities)?.[1];
	if (!name)
		return stop(
			"no development certificate on this Mac: open Xcode, Settings, Accounts, add your Apple ID (a free one will do), then Manage Certificates, +, Apple Development",
		);
	const pem = join(tmpdir(), `mainworthy-ios-${process.pid}.pem`);
	try {
		writeFileSync(pem, (await read("security", ["find-certificate", "-c", name, "-p"])) ?? "");
		const subject = (await read("openssl", ["x509", "-in", pem, "-noout", "-subject", "-nameopt", "RFC2253"])) ?? "";
		return /(?:^|,)OU=([A-Z0-9]{10})(?:,|$)/.exec(subject)?.[1] ?? stop(`the certificate "${name}" names no team`);
	} finally {
		rmSync(pem, { force: true });
	}
}

const Phones = z.object({
	result: z.object({
		devices: z.array(
			z.object({
				identifier: z.string(),
				deviceProperties: z.object({ name: z.string().optional() }),
				hardwareProperties: z.object({
					udid: z.string().optional(),
					platform: z.string().optional(),
					reality: z.string().optional(),
				}),
				connectionProperties: z.object({ pairingState: z.string().optional(), tunnelState: z.string().optional() }),
			}),
		),
	}),
});
type Phone = { id: string; udid: string; name: string; reachable: boolean };
/** The paired iPhone to install on: the one, or the one `--device` names. */
async function phone(named: string | undefined): Promise<Phone> {
	const file = join(tmpdir(), `mainworthy-ios-devices-${process.pid}.json`);
	try {
		await ran("xcrun", ["devicectl", "list", "devices", "--json-output", file], { quiet: true });
		const phones: Phone[] = Phones.parse(JSON.parse(readFileSync(file, "utf8")))
			.result.devices.filter(
				(device) =>
					device.hardwareProperties.reality === "physical" &&
					device.hardwareProperties.platform === "iOS" &&
					device.connectionProperties.pairingState === "paired",
			)
			.map((device) => ({
				id: device.identifier,
				udid: device.hardwareProperties.udid ?? "",
				name: device.deviceProperties.name ?? "iPhone",
				// A paired phone that is locked, asleep or on another network is listed and cannot be installed on.
				reachable: device.connectionProperties.tunnelState !== "unavailable",
			}))
			.filter((device) => named === undefined || device.name === named);
		const [only, ...others] = phones;
		if (!only)
			return stop(
				named
					? `no paired iPhone is called "${named}"`
					: "no iPhone is paired with this Mac: connect it with a cable, unlock it and choose Trust",
			);
		if (others.length > 0)
			return stop(`more than one iPhone is paired; name one: --device "${phones.map((p) => p.name).join('" or "')}"`);
		return only;
	} finally {
		rmSync(file, { force: true });
	}
}

/**
 * The app as Apple names it, `<team>.<bundle identifier>`, from Local.xcconfig, where that file signs it with the
 * entitlements that tie it to mainworthy.com (a paid team only, `ios/Config/Base.xcconfig`). Null otherwise.
 */
function appleApp(): string | null {
	const text = readFileSync(LOCAL, "utf8");
	const setting = (name: string) => text.match(new RegExp(`^${name}\\s*=\\s*(\\S+)`, "m"))?.[1];
	if (!setting("CODE_SIGN_ENTITLEMENTS")) return null;
	const team = setting("DEVELOPMENT_TEAM");
	const bundle = setting("MAINWORTHY_BUNDLE_ID");
	return team && bundle ? `${team}.${bundle}` : null;
}

/** What the instance must list for the sign-in screen to be offered its saved logins (`docs/deploy.md`). */
const associate = (appId: string): string =>
	`For the sign-in screen to be offered the logins saved for mainworthy.com, that instance lists this app in MAINWORTHY_APPLE_APPS: ${appId}`;

/**
 * Builds the app for a phone, signs it with the team of this Mac's development certificate, and installs it.
 * A free Apple ID will do. Its signing lasts seven days, so this is then run again each week: the app keeps
 * its sign-in across it.
 */
async function install(args: string[]): Promise<void> {
	await needMac();
	const dryRun = args.includes("--dry-run");
	const named = args.includes("--device") ? args[args.indexOf("--device") + 1] : undefined;
	if (!existsSync(LOCAL)) {
		const id = await team();
		writeFileSync(
			LOCAL,
			[
				"// Written by `bun scripts/ios.ts install` from the development certificate on this Mac. Not committed.",
				`DEVELOPMENT_TEAM = ${id}`,
				"// A bundle identifier belongs to one team for good, so this one ends in the team's own id.",
				`MAINWORTHY_BUNDLE_ID = com.mainworthy.app.${id}`,
				"// A paid team can tie the app to mainworthy.com, so the sign-in screen is offered its saved logins:",
				"// CODE_SIGN_ENTITLEMENTS = App/Mainworthy.entitlements",
				"",
			].join("\n"),
		);
		console.log("wrote ios/Config/Local.xcconfig with the team of this Mac's development certificate");
	}
	await project();
	const appId = appleApp();
	const built = join(CACHE, "phone");
	const app = join(built, "Build", "Products", "Debug-iphoneos", "Mainworthy.app");
	const build = (destination: string): Promise<void> =>
		xcodebuild([
			"build",
			"-destination",
			destination,
			"-derivedDataPath",
			built,
			// Lets Xcode register the bundle identifier with the team and fetch the profile, and, with the second
			// flag, register a phone the team has not seen.
			"-allowProvisioningUpdates",
			"-allowProvisioningDeviceRegistration",
		]);
	if (dryRun) {
		// No phone is asked for: the app is built and signed for any iPhone the team has registered.
		await build("generic/platform=iOS");
		console.log(`built and signed: ${app}\nnothing was installed (--dry-run)`);
		if (appId) console.log(associate(appId));
		return;
	}
	const target = await phone(named);
	if (!target.reachable)
		stop(`${target.name} is paired and cannot be reached: unlock it, and connect it with a cable or to this Wi-Fi`);
	console.log(`building for ${target.name}`);
	await build(`platform=iOS,id=${target.udid}`);
	await run("xcrun", ["devicectl", "device", "install", "app", "--device", target.id, app]);
	console.log(
		[
			`installed on ${target.name}.`,
			"The first time, the phone asks you to trust the developer: Settings, General, VPN & Device Management.",
			"The app says under You until when its signing lasts: seven days with a free Apple ID. Run this again before then; the sign-in is kept.",
			...(appId ? [associate(appId)] : []),
		].join("\n"),
	);
}

const COMMANDS: Record<string, (args: string[]) => void | Promise<void>> = {
	gen: () => gen(),
	serve: () => serve(),
	test: (args) => test(args[0]),
	project: () => project(),
	build: () => build(),
	uitest: (args) => uitest(args[0]),
	install: (args) => install(args),
};

const [command = "", ...args] = process.argv.slice(2);
const chosen = COMMANDS[command];
if (!chosen) {
	console.error(`usage: bun scripts/ios.ts <${Object.keys(COMMANDS).join("|")}>`);
	process.exit(2);
}
try {
	await chosen(args);
} catch (error) {
	if (!(error instanceof Stop)) throw error;
	console.error(`ios: ${error.message}`);
	process.exit(1);
}
