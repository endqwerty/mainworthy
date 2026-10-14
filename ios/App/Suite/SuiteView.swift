import MainworthyClient
import MainworthyScreens
import SwiftUI

struct SuiteRoute: Hashable {
	let ref: String
	var version: Int? = nil
	var history = false
}

struct SuiteView: View {
	let screen: SuiteScreen
	let workspace: Workspace
	@State private var path: [SuiteRoute] = []
	@State private var search = ""

	var body: some View {
		NavigationStack(path: $path) {
			List {
				Section {
					TextField("Search cases", text: $search)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.accessibilityIdentifier("suite-search")
					Picker("Tag", selection: tag) {
						Text("All tags").tag(String?.none)
						ForEach(screen.tags) { tag in
							Text("\(tag.name) (\(tag.count))").tag(Optional(tag.name))
						}
					}
					.accessibilityIdentifier("suite-tag")
				}
				if screen.place != .root {
					Section {
						Button { Task { await screen.up() } } label: {
							Label("Back to folders", systemImage: "chevron.left")
						}
						.accessibilityIdentifier("suite-up")
						if let folder = screen.place.path { Text(folder).foregroundStyle(.secondary) }
					}
				}
				if screen.showsFolders {
					Section("Folders") {
						ForEach(screen.children) { folder in
							Button { Task { await screen.show(.folder(folder)) } } label: {
								HStack {
									Label(folder.name, systemImage: "folder")
									Spacer()
									Text("\(folder.cases)").foregroundStyle(.secondary)
									Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
								}
								.foregroundStyle(.primary)
							}
							.accessibilityIdentifier("folder-\(folder.path)")
						}
					}
				}
				if screen.place == .root, search.isEmpty, screen.tag == nil {
					Section {
						Button { Task { await screen.show(.all) } } label: {
							Label("All cases", systemImage: "list.bullet.rectangle")
						}
					}
				}
				if screen.showsCases {
					Section("Cases") {
						ForEach(screen.cases) { item in
							NavigationLink(value: SuiteRoute(ref: item.ref)) { SuiteCaseRow(item: item) }
								.accessibilityIdentifier("suite-case-\(item.ref)")
						}
						if screen.hasMore {
							ProgressView().frame(maxWidth: .infinity).task { await screen.more() }
						} else if screen.cases.isEmpty, screen.loading == .done {
							Text("No cases found").foregroundStyle(.secondary)
						}
					}
				}
				if case .first = screen.loading { ProgressView().frame(maxWidth: .infinity) }
				if case .failed(let why) = screen.loading {
					Section {
						Text(why).foregroundStyle(Color.fail)
						Button("Try again") { Task { await screen.refresh() } }
					}
				}
			}
			.navigationTitle("Suite")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ProjectMenu(workspace: workspace)
				if workspace.project?.may(.produce) == true {
					ToolbarItem(placement: .topBarTrailing) {
						Button { screen.newCase() } label: { Label("New case", systemImage: "plus") }
							.accessibilityIdentifier("suite-new")
					}
				}
			}
			.navigationDestination(for: SuiteRoute.self) { route in
				if route.history {
					SuiteHistoryView(ref: route.ref, screen: screen)
				} else {
					SuiteCaseView(route: route, screen: screen, workspace: workspace)
				}
			}
			.refreshable { await screen.refresh() }
		}
		.safeAreaInset(edge: .bottom) {
			if let notice = screen.notice {
				HStack {
					Text(notice).font(.subheadline).foregroundStyle(Color.fail)
					Spacer()
					Button("Dismiss") { screen.dismissNotice() }
				}
				.padding(12).background(.regularMaterial)
			}
		}
		.task { await screen.show(screen.place, text: screen.text, tag: screen.tag) }
		.task(id: search) {
			guard search != screen.text else { return }
			do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
			await screen.show(screen.place, text: search, tag: screen.tag)
		}
		.sheet(isPresented: editing) {
			if let editor = screen.editor { SuiteEditorView(editor: editor, screen: screen) }
		}
		.onChange(of: screen.saved) { _, stamp in
			if let stamp { path = [SuiteRoute(ref: stamp.ref)] }
		}
	}

	private var tag: Binding<String?> {
		Binding(get: { screen.tag }, set: { tag in
			Task { await screen.show(screen.place, text: search, tag: tag) }
		})
	}
	private var editing: Binding<Bool> {
		Binding(get: { screen.editor != nil }, set: { if !$0 { screen.closeEditor() } })
	}
}

private struct SuiteCaseRow: View {
	let item: SuiteCase
	var body: some View {
		VStack(alignment: .leading, spacing: 5) {
			RefText(item.ref)
			Text(item.title).font(.body.weight(.medium))
			if !item.tags.isEmpty {
				Text(item.tags.map { "#\($0)" }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
			}
			ForEach(Array(item.proof.enumerated()), id: \.offset) { _, proof in
				Text(proof.sentence).font(.caption)
					.foregroundStyle(proof.outcome == .pass ? Color.pass : proof.outcome == .fail ? .fail : .secondary)
			}
		}
		.padding(.vertical, 3)
	}
}
