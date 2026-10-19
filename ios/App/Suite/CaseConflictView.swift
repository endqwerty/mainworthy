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
		ForEach(conflict.addresses, id: \.self) { address in
			Section(conflict.label(address)) {
				VStack(alignment: .leading, spacing: 8) {
					Text("Your draft").font(.headline)
					Text(conflict.text(address, side: .mine)).textSelection(.enabled)
					Button("Use my version") { editor.chooseConflict(address, side: .mine) }
						.accessibilityIdentifier("conflict-mine-\(address.label)")
					Divider()
					Text("Current version").font(.headline)
					Text(conflict.text(address, side: .current)).textSelection(.enabled)
					Button("Use current version") { editor.chooseConflict(address, side: .current) }
						.accessibilityIdentifier("conflict-current-\(address.label)")
					if conflict.chosen.contains(address) {
						Label(conflict.selections[address] == .mine ? "Chosen: your draft" : "Chosen: current version", systemImage: "checkmark.circle").foregroundStyle(.secondary)
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
			Text("Who may run it").font(.subheadline).foregroundStyle(.secondary)
			MethodBadges(methods: conflict.merged.methods)
			Text("Automation: " + conflict.merged.automate)
			ForEach(conflict.merged.fields.keys.sorted(), id: \.self) { key in
				Text("\(key): \(conflict.merged.fields[key] ?? "")")
			}
		}
	}
}
