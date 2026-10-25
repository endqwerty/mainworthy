import { createHash } from "node:crypto";
import { connect, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { z } from "zod";
import type { App } from "./app.ts";
import type { JobClaim, JobInput } from "./jobs.ts";
import type { MailConfig } from "./mail.ts";

const Message = z.object({ to: z.string(), subject: z.string(), text: z.string() });
export type MailMessage = z.infer<typeof Message>;
type Message = MailMessage;
export async function executeMail(app: App, claim: JobClaim, input: JobInput): Promise<void> {
	const message = Message.parse(input);
	const config = app.config.mail;
	if (!config) throw new Error("mail is off on this instance");
	try {
		await sendMail(config, message, claim.id);
	} catch (error) {
		console.warn("[mainworthy] mail delivery failed; check SMTP configuration and request a new link");
		throw error;
	}
}

function replies(socket: Socket) {
	const ready: number[] = [];
	let pending: ReturnType<typeof Promise.withResolvers<number>> | null = null;
	let buffer = "";
	let bytes = 0;
	let code: string | null = null;
	let failure: Error | null = null;
	const failed = () => {
		failure = new Error("SMTP exchange failed");
		pending?.reject(failure);
		pending = null;
	};
	const data = (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		if (buffer.length > 65_536) {
			failed();
			socket.destroy();
			return;
		}
		while (buffer.includes("\r\n")) {
			const at = buffer.indexOf("\r\n");
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 2);
			bytes += line.length + 2;
			const match = /^(\d{3})(?:([ -])|$)/.exec(line);
			if (!match || bytes > 65_536 || (code !== null && code !== match[1])) {
				failed();
				socket.destroy();
				return;
			}
			code = match[1] ?? null;
			if (match[2] !== "-") {
				const value = Number(code);
				if (pending) {
					pending.resolve(value);
					pending = null;
				} else ready.push(value);
				bytes = 0;
				code = null;
				if (ready.length > 20) {
					failed();
					socket.destroy();
					return;
				}
			}
		}
	};
	socket.on("data", data);
	socket.on("error", failed);
	socket.on("close", failed);
	return {
		async read(): Promise<number> {
			const buffered = ready.shift();
			if (buffered !== undefined) return buffered;
			if (failure) throw failure;
			pending = Promise.withResolvers<number>();
			return pending.promise;
		},
		detach() {
			socket.off("data", data);
			socket.off("error", failed);
			socket.off("close", failed);
		},
	};
}

const createMessageId = (id: string): string => createHash("sha256").update(id).digest("hex");

async function sendMail(config: MailConfig, message: Message, id: string): Promise<void> {
	const options = {
		host: config.host,
		port: config.port,
		rejectUnauthorized: true,
		...(isIP(config.host) ? {} : { servername: config.host }),
	};
	let socket: Socket = config.tls === "tls" ? connectTls(options) : connect(options);
	let channel = replies(socket);
	const deadline = setTimeout(() => socket.destroy(new Error("SMTP timeout")), 5000);
	const expect = async (...codes: number[]) => {
		if (!codes.includes(await channel.read())) throw new Error("SMTP exchange refused");
	};
	const command = async (line: string, ...codes: number[]) => {
		socket.write(`${line}\r\n`);
		await expect(...codes);
	};
	try {
		await expect(220);
		await command("EHLO mainworthy", 250);
		if (config.tls === "starttls") {
			await command("STARTTLS", 220);
			channel.detach();
			socket = connectTls({ ...options, socket });
			channel = replies(socket);
			await command("EHLO mainworthy", 250);
		}
		if (config.auth)
			await command(`AUTH PLAIN ${Buffer.from(`\0${config.auth.user}\0${config.auth.pass}`).toString("base64")}`, 235);
		await command(`MAIL FROM:<${config.from}>`, 250);
		await command(`RCPT TO:<${message.to}>`, 250, 251);
		await command("DATA", 354);
		const text =
			Buffer.from(message.text.replace(/\r?\n/g, "\r\n"))
				.toString("base64")
				.match(/.{1,76}/g)
				?.join("\r\n") ?? "";
		socket.write(
			[
				`Date: ${new Date().toUTCString()}`,
				`From: <${config.from}>`,
				`To: <${message.to}>`,
				`Subject: =?UTF-8?B?${Buffer.from(message.subject).toString("base64")}?=`,
				`Message-ID: <${createMessageId(id)}@${config.from.split("@")[1]}>`,
				"MIME-Version: 1.0",
				'Content-Type: text/plain; charset="UTF-8"',
				"Content-Transfer-Encoding: base64",
				"",
				text,
				".",
				"",
			].join("\r\n"),
		);
		await expect(250);
		await command("QUIT", 221);
	} finally {
		clearTimeout(deadline);
		socket.destroy();
	}
}
