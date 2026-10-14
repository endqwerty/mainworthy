import MainworthyClient
import MainworthyScreens
import SwiftUI

struct SuiteEditorView: View {
	@Bindable var editor: CaseEditorScreen
	let screen: SuiteScreen
	@State private var discarding = false

	var body: some View {
		NavigationStack {
			Form {
				Section("Title") {
					TextField("Case title", text: $editor.content.title, axis: .vertical)
						.accessibilityIdentifier("editor-title")
				}
				Section("Preconditions") {
					TextField("What must hold before", text: $editor.content.pre, axis: .vertical)
						.lineLimit(2...6).accessibilityIdentifier("editor-pre")
				}
				Section("Steps") {
					ForEach($editor.content.steps) { $step in
						VStack(alignment: .leading, spacing: 8) {
							TextField("Action", text: $step.action, axis: .vertical)
								.accessibilityIdentifier("editor-action-\(step.id)")
							TextField("Expected result (optional)", text: expected($step), axis: .vertical)
								.font(.subheadline).accessibilityIdentifier("editor-expected-\(step.id)")
						}
						.padding(.vertical, 4)
					}
					.onDelete { editor.removeSteps(at: $0) }
					.onMove { editor.moveSteps(from: $0, to: $1) }
					Button { editor.addStep() } label: { Label("Add step", systemImage: "plus") }
						.accessibilityIdentifier("editor-add-step")
				}
				Section("Reason (optional)") {
					TextField("Why this change", text: $editor.reason, axis: .vertical)
						.accessibilityIdentifier("editor-reason")
				}
				if let notice = editor.notice {
					Section { Text(notice).accessibilityIdentifier("editor-notice") }
				}
			}
			.scrollDismissesKeyboard(.interactively)
			.disabled(editor.locked)
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(editor.settled ? "Done" : "Cancel") {
						if editor.dirty && !editor.settled { discarding = true } else { screen.closeEditor() }
					}
					.disabled(editor.busy).accessibilityIdentifier("editor-cancel")
				}
				ToolbarItemGroup(placement: .confirmationAction) {
					if !editor.locked { EditButton().accessibilityIdentifier("editor-reorder") }
					if !editor.settled {
						Button(editor.isRetrying ? "Retry" : "Save") { Task { await screen.saveEditor() } }
							.disabled(!editor.maySave).accessibilityIdentifier("editor-save")
					}
				}
			}
			.alert("Discard this draft?", isPresented: $discarding) {
				Button("Discard", role: .destructive) { screen.closeEditor() }
				Button("Keep editing", role: .cancel) {}
			}
		}
		.interactiveDismissDisabled((editor.dirty && !editor.settled) || editor.busy)
	}

	private var title: String { if case .edit(let opened) = editor.source { "Edit \(opened.ref)" } else { "New case" } }
	private func expected(_ step: Binding<Step>) -> Binding<String> {
		Binding(get: { step.wrappedValue.expected ?? "" }, set: { step.wrappedValue.expected = $0.isEmpty ? nil : $0 })
	}
}
