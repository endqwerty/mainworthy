import MainworthyClient
import MainworthyScreens
import SwiftUI

struct RunPlannerView: View {
	let screen: RunsScreen
	let planned: (Run) -> Void
	let cancel: () -> Void
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

	init(screen: RunsScreen, planned: @escaping (Run) -> Void, cancel: @escaping () -> Void) {
		self.screen = screen
		self.planned = planned
		self.cancel = cancel
		if let submission = screen.planSubmission {
			_name = State(initialValue: submission.name)
			_commit = State(initialValue: submission.commit)
			_acceptsCommit = State(initialValue: !submission.commit.isEmpty)
			switch submission.selection {
			case .all: break
			case .folder(let path):
				_mode = State(initialValue: .folder)
				_folder = State(initialValue: path)
			case .tag(let tag):
				_mode = State(initialValue: .tag)
				_filter = State(initialValue: tag)
			case .text(let text):
				_mode = State(initialValue: .text)
				_filter = State(initialValue: text)
			}
		}
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
						caseCount
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
				}.disabled(screen.planSubmission != nil || screen.planning)
				if let notice = screen.notice { Section { Text(notice).accessibilityIdentifier("plan-notice") } }
			}
			.navigationTitle(screen.savedPlan == nil ? "Plan a run" : "Run planned").navigationBarTitleDisplayMode(
				.inline
			)
			.toolbar {
				ToolbarItem(placement: .keyboard) { Button("Done") { typing = nil } }
				ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
				ToolbarItem(placement: .confirmationAction) {
					Button(screen.savedPlan != nil ? "Read run again" : screen.planSubmission != nil ? "Retry plan" : "Plan") {
						Task {
							let run =
								if screen.savedPlan != nil {
									await screen.readPlannedRun()
								} else {
									await screen.plan(
										name: name, selection: selection ?? .all, commit: acceptsCommit ? commit : "")
								}
							if let run {
								planned(run)
							}
						}
					}
					.disabled(
						screen.planning || (screen.planSubmission == nil && (!valid || !screen.permission.may(.plan)))
					)
					.accessibilityIdentifier("submit-run-plan")
				}
			}
			.task { await screen.readFolders() }
			.task(id: selection) { await screen.countCases(selection) }
		}
	}

	private var selection: RunSelection? {
		if let submitted = screen.planSubmission { return submitted.selection }
		let query = filter.trimmingCharacters(in: .whitespacesAndNewlines)
		switch mode {
		case .all: return .all
		case .folder: return folder.map(RunSelection.folder)
		case .tag: return query.isEmpty ? nil : .tag(query)
		case .text: return query.isEmpty ? nil : .text(query)
		}
	}

	@ViewBuilder private var caseCount: some View {
		switch screen.caseCount {
		case .idle: Text("Choose cases to count.")
		case .loading: Text("Counting matching cases…")
		case .counted(let count): Text("\(count) matching cases").accessibilityIdentifier("run-case-count")
		case .failed(let why): Text("Cases could not be counted. " + why).accessibilityIdentifier("run-count-error")
		}
	}

	private var valid: Bool {
		!name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& (!acceptsCommit || commit.trimmingCharacters(in: .whitespacesAndNewlines).count >= 7)
			&& (mode != .folder || folder != nil)
			&& ((mode != .tag && mode != .text) || !filter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
	}
}
