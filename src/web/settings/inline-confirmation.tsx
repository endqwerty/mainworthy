import { type KeyboardEvent, useLayoutEffect, useRef } from "react";

export function InlineConfirmation({
	open,
	onOpen,
	onCancel,
	onConfirm,
	trigger,
	triggerLabel,
	confirm,
	disabled = false,
	busy = false,
}: {
	open: boolean;
	onOpen: () => void;
	onCancel: () => void;
	onConfirm: () => void;
	trigger: string;
	triggerLabel?: string;
	confirm: string;
	disabled?: boolean;
	busy?: boolean;
}) {
	const triggerButton = useRef<HTMLButtonElement>(null);
	const confirmButton = useRef<HTMLButtonElement>(null);
	const cancelled = useRef(false);

	useLayoutEffect(() => {
		if (open) confirmButton.current?.focus();
		else if (cancelled.current) triggerButton.current?.focus();
		cancelled.current = false;
	}, [open]);

	function cancel(): void {
		cancelled.current = true;
		onCancel();
	}

	function cancelOnEscape(event: KeyboardEvent<HTMLButtonElement>): void {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		cancel();
	}

	return open ? (
		<>
			<button
				className="out"
				type="button"
				ref={confirmButton}
				disabled={disabled}
				aria-disabled={busy}
				onClick={onConfirm}
				onKeyDown={cancelOnEscape}
			>
				{confirm}
			</button>
			<button type="button" className="dim settings-confirm-cancel" onClick={cancel} onKeyDown={cancelOnEscape}>
				Cancel
			</button>
		</>
	) : (
		<button
			className="out"
			type="button"
			ref={triggerButton}
			disabled={disabled}
			aria-disabled={busy}
			aria-label={triggerLabel}
			onClick={onOpen}
		>
			{trigger}
		</button>
	);
}
