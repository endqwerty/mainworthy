import MainworthyClient
import MainworthyScreens
import SwiftUI

struct RunPlannerView: View {
	let screen: RunsScreen
	let planned: (Run) -> Void
	@Environment(\.dismiss) private var dismiss
	@State private var name = ""
	@State private var mode = Selection.all
	@State private var filter = ""
	@State private var folder: String?
	@State private var acceptsCommit = false
	@State private var commit = ""
	@FocusState private var typing: Field?
	private enum Field { case name, filter, commit }
	private enum Selection: String, CaseIterable {
		case all = "All cases"
		case folder = "Folder"
		case tag = "Tag"
		case text = "Search"
	}

	var body: some View {
		NavigationStack {
			Form {
				Group {
					Section("Name") {
						TextField("Run name", text: $name).focused($typing, equals: .name).accessibilityIdentifier(
							"run-name")
					}
					Section("Cases") {
						Picker("Select", selection: $mode) {
							ForEach(Selection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
						}.accessibilityIdentifier("run-selection")
						if mode == .folder {
							Picker("Folder", selection: $folder) {
								Text("Choose a folder").tag(Optional<String>.none)
								ForEach(screen.folders, id: \.self) { path in
									Text(path.isEmpty ? "Root" : path).tag(Optional(path))
								}
							}
						} else if mode == .tag || mode == .text {
							TextField(mode == .tag ? "Tag" : "Search cases", text: $filter)
								.accessibilityIdentifier("run-filter").textInputAutocapitalization(.never).focused(
									$typing, equals: .filter)
						}
					}
					Section {
						Toggle("Accept results for a commit", isOn: $acceptsCommit)
						if acceptsCommit {
							TextField("Commit SHA", text: $commit).textInputAutocapitalization(.never)
								.autocorrectionDisabled()
								.focused($typing, equals: .commit)
						}
					} footer: {
						Text(
							acceptsCommit
								? "The server resolves an abbreviated commit."
								: "Counts only results recorded in this run.")
					}
				}.disabled(screen.savedPlan != nil || screen.planning)
				if let notice = screen.notice { Section { Text(notice).accessibilityIdentifier("plan-notice") } }
			}
			.navigationTitle(screen.savedPlan == nil ? "Plan a run" : "Run planned").navigationBarTitleDisplayMode(
				.inline
			)
			.toolbar {
				ToolbarItem(placement: .keyboard) { Button("Done") { typing = nil } }
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button(screen.savedPlan == nil ? "Plan" : "Read run again") {
						let selection: RunSelection =
							switch mode {
							case .all: .all
							case .folder: .folder(folder ?? "")
							case .tag: .tag(filter.trimmingCharacters(in: .whitespacesAndNewlines))
							case .text: .text(filter.trimmingCharacters(in: .whitespacesAndNewlines))
							}
						Task {
							let run =
								if screen.savedPlan != nil {
									await screen.readPlannedRun()
								} else {
									await screen.plan(
										name: name, selection: selection, commit: acceptsCommit ? commit : "")
								}
							if let run {
								planned(run)
							}
						}
					}
					.disabled(
						screen.planning || (screen.savedPlan == nil && (!valid || !screen.permission.may(.plan)))
					)
					.accessibilityIdentifier("submit-run-plan")
				}
			}
			.task { await screen.readFolders() }
		}
	}

	private var valid: Bool {
		!name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& (!acceptsCommit || commit.trimmingCharacters(in: .whitespacesAndNewlines).count >= 7)
			&& (mode != .folder || folder != nil)
			&& ((mode != .tag && mode != .text) || !filter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
	}
}
