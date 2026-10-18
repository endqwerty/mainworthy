import { type ComponentPropsWithoutRef, useLayoutEffect, useRef } from "react";

function fit(element: HTMLTextAreaElement): void {
	element.style.height = "auto";
	element.style.height = `${element.scrollHeight}px`;
}

export function AutoGrowingTextarea({
	value,
	...props
}: Omit<ComponentPropsWithoutRef<"textarea">, "value"> & { value: string }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Text changes invalidate the measured height.
	useLayoutEffect(() => {
		if (ref.current) fit(ref.current);
	}, [value]);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		let width: number | null = null;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.contentRect.width === width) continue;
				width = entry.contentRect.width;
				fit(element);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return <textarea {...props} ref={ref} value={value} />;
}
