import { EmptyState } from "../ui/index.tsx";
export function SettingsScreen() {
	return (
		<>
			<section className="pane" id="list">
				<div className="phead">
					<b>Settings</b>
				</div>
				<EmptyState>Choose a project policy and connect your producers here.</EmptyState>
			</section>
			<section className="pane" id="detail">
				<EmptyState>Settings details appear here.</EmptyState>
			</section>
		</>
	);
}
