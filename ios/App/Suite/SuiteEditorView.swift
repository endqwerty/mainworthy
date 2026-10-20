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
				if let conflict = editor.conflict {
					CaseConflictView(editor: editor, conflict: conflict)
				} else {
					Group {
						Section("Title") {
							TextField("Case title", text: $editor.content.title, axis: .vertical)
								.accessibilityIdentifier("editor-title")
							Text("\(editor.content.title.utf16.count)/300 UTF-16 units")
								.font(.caption).foregroundStyle(editor.content.title.utf16.count > 300 ? Color.fail : .secondary)
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
							Text("\(editor.reason.utf16.count)/500 UTF-16 units")
								.font(.caption).foregroundStyle(editor.reason.utf16.count > 500 ? Color.fail : .secondary)
						}
						if !editor.validation.isEmpty {
							Section("Before saving") {
								ForEach(editor.validation, id: \.self) { Text($0).foregroundStyle(Color.fail) }
							}
							.accessibilityIdentifier("editor-validation")
						}
					}.disabled(editor.locked)
				}
				if let notice = editor.notice {
					Section {
						Text(notice).accessibilityIdentifier("editor-notice")
						if editor.isWaiting {
							Text("Editing pauses while the proposal waits. Retry checks its answer.")
								.font(.caption).foregroundStyle(.secondary)
						}
					}
				}
			}
			.scrollDismissesKeyboard(.interactively)
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(editor.settled ? "Done" : "Cancel") {
						if editor.dirty && !editor.settled { discarding = true } else { screen.closeEditor() }
					}
					.disabled(editor.busy).accessibilityIdentifier("editor-cancel")
				}
				// Saving commits the edit and is the prominent action; reordering the steps is a plain one beside it.
				if !editor.locked {
					ToolbarItem(placement: .topBarTrailing) { EditButton().accessibilityIdentifier("editor-reorder") }
					ToolbarSpacer(.fixed, placement: .topBarTrailing)
				}
				if !editor.settled {
					ToolbarItem(placement: .confirmationAction) {
						Button(editor.isRetrying ? "Retry" : editor.conflict != nil ? "Record merge" : "Save") { Task { await screen.saveEditor() } }
							.buttonStyle(.glassProminent)
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
