import { useEffect, useState } from "react";
import type { Attachment } from "../../core/attachments.ts";
import { AttachmentReply } from "../../core/attachments.ts";
import { call } from "../lib/api.ts";
import { useQueryOp } from "../lib/data.ts";
import { deviceSession, sessionCurrent } from "../lib/device.ts";
import { useApp } from "./context.tsx";

function FileAttachment({ result, item }: { result: number; item: Attachment }) {
	const { project } = useApp();
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const image = item.type.startsWith("image/");
	useEffect(() => {
		if (!image) return;
		const owner = deviceSession();
		let gone = false;
		let objectUrl: string | null = null;
		void call("attachment", { result, id: item.id }, { project, owner })
			.then((reply) => {
				const file = AttachmentReply.parse(reply);
				if (file.kind !== "file" || gone || !sessionCurrent(owner)) return;
				const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
				objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.attachment.type }));
				setUrl(objectUrl);
			})
			.catch(() => {
				if (!gone) setError("Could not read this attachment.");
			});
		return () => {
			gone = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [image, project, result, item.id]);
	async function download() {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const owner = deviceSession();
			const file = AttachmentReply.parse(await call("attachment", { result, id: item.id }, { project, owner }));
			if (file.kind !== "file" || !sessionCurrent(owner)) return;
			const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
			const link = document.createElement("a");
			const downloadUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
			link.href = downloadUrl;
			link.download = file.attachment.name;
			link.click();
			setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
		} catch {
			setError("Could not download this attachment.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<li className="result-attachment">
			{image && url && <img className="result-attachment-image" src={url} alt={item.name} />}
			<button type="button" disabled={busy} onClick={() => void download()}>
				Download {item.name}
			</button>{" "}
			<span className="dim">
				{item.size.toLocaleString()} bytes{item.at ? ` · step ${item.at}` : ""}
			</span>
			{error && <span role="status">{error}</span>}
		</li>
	);
}
export function ResultAttachments({ result, index }: { result: number; index?: number }) {
	const { project } = useApp();
	const read = useQueryOp({ project, op: "attachment", input: { result }, enabled: result > 0 });
	const parsed = AttachmentReply.safeParse(read.data);
	if (read.error) return <p className="dim">Attachments could not be read.</p>;
	if (
		read.isPlaceholderData ||
		!parsed.success ||
		parsed.data.kind !== "list" ||
		parsed.data.items.length === 0 ||
		parsed.data.items.some((item) => item.result !== result)
	)
		return null;
	return (
		<ul className="result-attachments" aria-label="Result attachments">
			{parsed.data.items
				.filter((_, ordinal) => index === undefined || index === ordinal)
				.map((item) => (
					<FileAttachment key={`${project}:${result}:${item.id}:${item.hash}`} result={result} item={item} />
				))}
		</ul>
	);
}
