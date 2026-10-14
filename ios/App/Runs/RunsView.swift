import MainworthyClient
import MainworthyScreens
import SwiftUI

struct RunsView: View {
	let screen: RunsScreen
	let workspace: Workspace
	@State private var path: [String] = []
	@State private var planning = false

	var body: some View {
		NavigationStack(path: $path) {
			List {
				ForEach(screen.runs) { run in
					NavigationLink(value: run.ref) {
						VStack(alignment: .leading, spacing: 6) {
							HStack {
								RefText(run.ref)
								Tag(text: run.verdict.word, tint: run.verdict.tint)
								Spacer()
								Text(run.state.word).font(.caption).foregroundStyle(.secondary)
							}
							Text(run.name).font(.headline)
							Text(
								run.left.map { "\($0) \($0 == 1 ? "case" : "cases") left" }
									?? "Remaining cases unavailable"
							).font(
								.subheadline
							).foregroundStyle(.secondary)
						}
						.padding(.vertical, 4)
					}
				}
				if screen.hasMore {
					Button("More runs") { Task { await screen.more() } }
				}
				if let notice = screen.notice { Text(notice).font(.subheadline) }
			}
			.overlay { empty }
			.refreshable { await screen.refresh() }
			.navigationTitle("Runs")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ProjectMenu(workspace: workspace)
				if workspace.project?.may(.plan) == true {
					ToolbarItem(placement: .topBarTrailing) {
						Button("Plan a run", systemImage: "plus") { planning = true }
							.accessibilityIdentifier("plan-run")
					}
				}
			}
			.navigationDestination(for: String.self) { ref in
				if let run = screen.runs.first(where: { $0.ref == ref }) {
					RunView(screen: screen.open(run))
				} else {
					ContentUnavailableView("Run unavailable", systemImage: "questionmark.folder")
				}
			}
			.sheet(isPresented: $planning) {
				RunPlannerView(screen: screen) { run in
					planning = false
					path.append(run.ref)
				}
			}
		}
		.task { if screen.loading == .first { await screen.refresh() } }
	}

	@ViewBuilder private var empty: some View {
		switch screen.loading {
		case .first: ProgressView()
		case .failed(let why):
			ContentUnavailableView {
				Label("Runs could not be read", systemImage: "exclamationmark.triangle")
			} description: {
				Text(why)
			} actions: {
				Button("Try again") { Task { await screen.refresh() } }
			}
		case .done:
			if screen.runs.isEmpty {
				ContentUnavailableView(
					"No planned runs", systemImage: "play.rectangle",
					description: Text(
						"Plan a run to pin a list of cases, then execute them here. Planning needs the plan capability."
					))
			}
		}
	}
}

extension RunVerdict {
	var tint: Color {
		switch self {
		case .passed: .pass
		case .failed: .fail
		case .blocked: .warn
		case .pending, .other: .secondary
		}
	}
}

extension SlotState {
	var tint: Color {
		switch self {
		case .satisfied: .pass
		case .failing: .fail
		case .disputed: .warn
		case .missing, .waived, .skipped, .other: .secondary
		}
	}
}
