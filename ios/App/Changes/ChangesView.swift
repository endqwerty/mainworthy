import MainworthyClient
import MainworthyScreens
import SwiftUI

struct ChangesView: View {
	let screen: ChangesScreen
	let workspace: Workspace

	var body: some View {
		NavigationStack {
			list
				.navigationTitle("Changes")
				.navigationBarTitleDisplayMode(.inline)
				.toolbar { ProjectMenu(workspace: workspace) }
				.navigationDestination(for: String.self) { key in
					ChangeView(key: key, screen: screen, workspace: workspace)
				}
		}
		.task { await screen.refresh() }
	}

	@ViewBuilder private var list: some View {
		switch screen.loading {
		case .first: ProgressView()
		case .failed(let why):
			ContentUnavailableView {
				Label("Changes could not be read", systemImage: "exclamationmark.triangle")
			} description: { Text(why) } actions: {
				Button("Try again") { Task { await screen.refresh() } }
			}
		case .done:
			List {
				if let notice = screen.notice { Text(notice).foregroundStyle(Color.fail) }
				ForEach(screen.changes) { change in
					NavigationLink(value: change.key) {
						VStack(alignment: .leading, spacing: 6) {
							HStack {
								Text(change.title).font(.body.weight(.medium))
								Spacer()
								Tag(text: change.verdict.name, tint: change.verdict.tint)
							}
							HStack {
								RefText(change.key)
								if change.state != .open { Tag(text: change.state.name, tint: .secondary) }
							}
							Text([change.branch, change.head.map { String($0.prefix(12)) }].compactMap { $0 }
								.joined(separator: " · "))
								.font(.footnote.monospaced()).foregroundStyle(.secondary)
						}
					}
					.accessibilityIdentifier("change-\(change.key)")
				}
			}
			.refreshable { await screen.refresh() }
			.overlay {
				if screen.changes.isEmpty {
					ContentUnavailableView {
						Label("No changes yet", systemImage: "arrow.triangle.branch")
					} description: {
						Text("A change appears when a pipeline reports results for a commit with a branch or pull request.")
					} actions: {
						Link("How to send a report", destination: workspace.docsAddress.appending(path: "report-results"))
					}
				}
			}
		}
	}
}

extension ChangeVerdict {
	var tint: Color {
		switch self {
		case .passed: .pass
		case .failed, .blocked: .fail
		case .pending: .warn
		case .other: .secondary
		}
	}
}
