import MainworthyClient
import MainworthyScreens
import SwiftUI

/// A change run: the gate of one reported commit, and every result it counted. It has no slots to work through.
struct ChangeRunView: View {
	let run: Run
	let results: ChangeResults

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				Text(run.name).font(.title2.weight(.semibold))
				Panel("Run") {
					if case .commit(let commit, _, _) = run.accepts {
						LabeledContent("Commit") {
							Text(commit.prefix(12)).font(.body.monospaced()).textSelection(.enabled)
						}
					}
					if case .change(let change?) = run.kind {
						LabeledContent("Change", value: change.key)
						if let title = change.title { Text(title).font(.subheadline) }
					}
					LabeledContent("Made") { Text(run.createdAt, format: .relative(presentation: .named)) }
					LabeledContent("State", value: run.state.word)
				}
				Panel("Gate") {
					Tag(text: run.verdict.word, tint: run.verdict.tint).accessibilityIdentifier("change-run-verdict")
					Text(run.reason)
				}
				ChangeResultsPanel(results: results)
			}
			.padding()
		}
		.navigationTitle(run.ref)
		.navigationBarTitleDisplayMode(.inline)
	}
}
