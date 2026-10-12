import { EmptyState } from "../ui/index.tsx";
export function QueueScreen() {
	return (
		<>
			<section className="pane" id="list">
				<div className="phead">
					<b>Queue</b>
				</div>
				<EmptyState>No questions yet. Pipeline failures and agent proposals appear here.</EmptyState>
			</section>
			<section className="pane" id="detail">
				<EmptyState>Queue details appear here.</EmptyState>
			</section>
		</>
	);
}
