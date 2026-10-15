import { createServer, type Socket } from "node:net";
import { createSecureContext, createServer as createTlsServer, TLSSocket } from "node:tls";

export async function fakeSmtp(
	options: { reject?: boolean; starttls?: boolean; implicit?: boolean; tls?: { key: Buffer; cert: Buffer } } = {},
) {
	const messages: { to: string; raw: string; text: string }[] = [];
	const commands: string[] = [];
	const sockets = new Set<Socket>();
	const attach = (socket: Socket, greeting = true) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = "";
		let data = false;
		let content: string[] = [];
		let recipient = "";
		if (greeting) socket.write("220 fake SMTP ready\r\n");
		const receive = (chunk: Buffer) => {
			buffer += chunk.toString();
			while (buffer.includes("\r\n")) {
				const end = buffer.indexOf("\r\n");
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (data) {
					if (line !== ".") {
						content.push(line.replace(/^\.\./, "."));
						continue;
					}
					data = false;
					const raw = content.join("\r\n");
					const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
					messages.push({
						to: recipient,
						raw,
						text: /Content-Transfer-Encoding: base64/i.test(raw)
							? Buffer.from(body.replace(/\s/g, ""), "base64").toString()
							: body
									.replace(/=\r\n/g, "")
									.replace(/=([A-F0-9]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
					});
					content = [];
					socket.write("250 accepted\r\n");
				} else {
					commands.push(line);
					if (line.startsWith("EHLO"))
						socket.write(`250-fake\r\n${options.starttls || options.tls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN\r\n`);
					else if (line === "STARTTLS" && options.tls) {
						socket.off("data", receive);
						socket.write("220 begin TLS\r\n");
						attach(new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(options.tls) }), false);
						return;
					} else if (line.startsWith("AUTH ")) socket.write("235 authenticated\r\n");
					else if (line.startsWith("MAIL FROM")) socket.write(options.reject ? "550 refused\r\n" : "250 sender\r\n");
					else if (line.startsWith("RCPT TO")) {
						recipient = line.slice(8);
						socket.write("250 recipient\r\n");
					} else if (line === "DATA") {
						data = true;
						socket.write("354 send data\r\n");
					} else if (line === "QUIT") socket.end("221 bye\r\n");
					else socket.write("502 unsupported\r\n");
				}
			}
		};
		socket.on("data", receive);
	};
	const server =
		options.implicit && options.tls
			? createTlsServer(options.tls, (socket) => attach(socket))
			: createServer((socket) => attach(socket));
	server.on("tlsClientError", () => {});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fake SMTP port");
	return {
		port: address.port,
		messages,
		commands,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
