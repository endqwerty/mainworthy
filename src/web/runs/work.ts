import { useEffect, useState } from "react";
import { invalidateProject } from "../lib/data.ts";

/** No write arrives when a lease expires. Read at its deadline and hide stale held values immediately. */
export function useWorkExpiry(project: string, until: number | null): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (until === null) return;
		const timer = setTimeout(
			() => {
				setNow(Date.now());
				void invalidateProject(project);
			},
			Math.max(0, until - Date.now()) + 1,
		);
		return () => clearTimeout(timer);
	}, [project, until]);
	return Math.max(now, Date.now());
}
