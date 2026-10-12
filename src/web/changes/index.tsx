import { EmptyState } from "../ui/index.tsx";
export function ChangesScreen() {
	return (
		<>
			<section className="pane" id="list">
				<div className="phead">
					<b>Changes</b>
				</div>
				<EmptyState>No changes yet. Report results for a branch or pull request.</EmptyState>
			</section>
			<section className="pane" id="detail">
				<EmptyState>Changes details appear here.</EmptyState>
			</section>
		</>
	);
}
