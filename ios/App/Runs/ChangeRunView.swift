import MainworthyClient
import MainworthyScreens
import SwiftUI

/// A run pushed from a change's page.
struct RunLink: Hashable {
	let ref: String
}

/// A change run: the gate of one reported commit, and every result it counted. It has no slots to work through.
/// Where the commit is and what the gate says head the page; the facts below it are one label and value a row.
struct ChangeRunView: View {
	let run: Run
	let results: ChangeResults
	let workspace: Workspace

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				VStack(alignment: .leading, spacing: 4) {
					Text(run.location?.label ?? run.name).font(.title2.weight(.semibold))
					Text(run.reason)
						.font(.subheadline.weight(.medium))
						.foregroundStyle(run.verdict.tint)
						.accessibilityIdentifier("change-run-verdict")
				}
				Panel {
					if let commit {
						LabeledContent("Commit") {
							Text(commit.prefix(12)).font(.body.monospaced()).textSelection(.enabled)
						}
					}
					if let change {
						LabeledContent("Change") {
							if let changes = workspace.changes {
								NavigationLink(change) { ChangeView(key: change, screen: changes, workspace: workspace) }
									.foregroundStyle(Color.accentColor)
							} else {
								Text(change)
							}
						}
					}
					LabeledContent("First report") { Text(run.createdAt, format: .relative(presentation: .named)) }
					LabeledContent("State", value: run.state.word)
					if let time = results.testTime, time.timed > 0 {
						LabeledContent("Test time") {
							VStack(alignment: .trailing) {
								Text(spent(time.ms))
								if time.timed < results.total {
									Text("\(time.timed) of \(results.total) results timed").font(.caption)
								}
							}
						}
					}
				}
				ChangeResultsPanel(results: results)
			}
			.padding()
		}
		.background(Color(.systemGroupedBackground))
		.navigationTitle(run.ref)
		.navigationBarTitleDisplayMode(.inline)
	}

	private var commit: String? {
		if let commit = run.location?.commit { return commit }
		if case .commit(let commit, _, _) = run.accepts { return commit }
		return nil
	}

	/// The change the commit belongs to, or the one it landed on trunk.
	private var change: String? {
		if case .change(let change?) = run.kind { return change.key }
		return run.location?.change
	}
}
