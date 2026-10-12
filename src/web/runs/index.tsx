import { EmptyState } from "../ui/index.tsx";
export function RunsScreen() {
	return (
		<>
			<section className="pane" id="list">
				<div className="phead">
					<b>Runs</b>
				</div>
				<EmptyState>No runs yet. Press n to plan one.</EmptyState>
			</section>
			<section className="pane" id="detail">
				<EmptyState>Runs details appear here.</EmptyState>
			</section>
		</>
	);
}
