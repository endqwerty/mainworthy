import type { ResultLocation as Location } from "../../core/ops.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { useApp } from "./context.tsx";

export function ResultLocation({ location }: { location: Location }) {
	const { project } = useApp();
	const url = location.change ? refUrl({ project, ref: location.change }) : null;
	return (
		<span className="result-location">
			{url ? (
				<a
					href={url}
					onClick={(event) => {
						event.preventDefault();
						navigate(url);
					}}
				>
					{location.label}
				</a>
			) : (
				<span>{location.label}</span>
			)}
			{location.commit && (
				<>
					{" "}
					<small className="mono dim">{location.commit.slice(0, 12)}</small>
				</>
			)}
		</span>
	);
}
