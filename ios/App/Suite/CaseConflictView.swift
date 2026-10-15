import MainworthyClient
import MainworthyScreens
import SwiftUI

struct CaseConflictView: View {
	let editor: CaseEditorScreen
	let conflict: CaseConflict

	var body: some View {
		Section("Both edits are kept") {
			Text("Choose each overlapping field. Changes that do not overlap are combined automatically.")
		}
		ForEach(conflict.paths, id: \.self) { path in
			Section(conflict.label(path)) {
				VStack(alignment: .leading, spacing: 8) {
					Text("Your draft").font(.headline)
					Text(conflict.text(path, side: .mine)).textSelection(.enabled)
					Button("Use my version") { editor.chooseConflict(path, side: .mine) }
						.accessibilityIdentifier("conflict-mine-\(path)")
					Divider()
					Text("Current version").font(.headline)
					Text(conflict.text(path, side: .current)).textSelection(.enabled)
					Button("Use current version") { editor.chooseConflict(path, side: .current) }
						.accessibilityIdentifier("conflict-current-\(path)")
					if conflict.chosen.contains(path) {
						Label(conflict.selections[path] == .mine ? "Chosen: your draft" : "Chosen: current version", systemImage: "checkmark.circle").foregroundStyle(.secondary)
					}
				}
				.buttonStyle(.borderless)
				.disabled(editor.busy || editor.isRetrying || editor.settled || editor.conflictClosed)
			}
		}
		Section("Merged case") {
			Text(conflict.merged.title).font(.headline)
			if !conflict.merged.pre.isEmpty { Text(conflict.merged.pre) }
			ForEach(Array(conflict.merged.steps.enumerated()), id: \.element.id) { index, step in
				VStack(alignment: .leading) {
					Text("\(index + 1). \(step.action)")
					if let expected = step.expected { Text(expected).foregroundStyle(.secondary) }
				}
			}
			Text("Methods: " + conflict.merged.methods.joined(separator: ", "))
			Text("Automation: " + conflict.merged.automate)
			ForEach(conflict.merged.fields.keys.sorted(), id: \.self) { key in
				Text("\(key): \(conflict.merged.fields[key] ?? "")")
			}
		}
	}
}
