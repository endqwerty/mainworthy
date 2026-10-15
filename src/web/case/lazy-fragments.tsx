import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

type Fragments = typeof import("./fragments.tsx");
type Loaded = { kind: "loaded"; module: Fragments } | { kind: "loading" } | { kind: "failed" };

function Controls({ children }: { children: (module: Fragments) => ReactNode }) {
	const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
	useEffect(() => {
		let current = true;
		void import("./fragments.tsx").then(
			(module) => current && setLoaded({ kind: "loaded", module }),
			() => current && setLoaded({ kind: "failed" }),
		);
		return () => {
			current = false;
		};
	}, []);
	return loaded.kind === "loaded" ? (
		children(loaded.module)
	) : (
		<p role="status">
			{loaded.kind === "failed"
				? "Could not load fragment controls. Reload to try again."
				: "Loading fragment controls…"}
		</p>
	);
}

export function FragmentReference(props: ComponentProps<Fragments["FragmentReference"]>) {
	return <Controls>{(module) => <module.FragmentReference {...props} />}</Controls>;
}

export function FragmentInsert(props: ComponentProps<Fragments["FragmentInsert"]>) {
	const [opened, setOpened] = useState(false);
	return (
		<details
			onToggle={(event) => {
				if (event.currentTarget.open) setOpened(true);
			}}
		>
			<summary>Insert fragment</summary>
			{opened && <Controls>{(module) => <module.FragmentInsert {...props} />}</Controls>}
		</details>
	);
}

export function FragmentUsers(props: ComponentProps<Fragments["FragmentUsers"]>) {
	return <Controls>{(module) => <module.FragmentUsers {...props} />}</Controls>;
}
